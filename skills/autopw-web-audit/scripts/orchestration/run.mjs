import fs from 'node:fs'
import path from 'node:path'

import { assertSchema } from '../lib/schema-validator.mjs'
import { executeCase, assertExecutorMap } from '../executors/index.mjs'
import { routeInput } from '../router/index.mjs'

const LANE_BY_EXECUTOR = {
  DIRECT_API: 'API',
  PLAYWRIGHT_TEST: 'PLAYWRIGHT_TEST',
  STATIC: 'STATIC',
  LOG_STATE: 'LOG_STATE',
  MCP_DIAGNOSTIC: 'MCP_DIAGNOSTIC'
}

const FOLDER_BY_LANE = {
  API: 'api',
  PLAYWRIGHT_TEST: 'playwright',
  STATIC: 'static',
  LOG_STATE: 'log-state',
  MCP_DIAGNOSTIC: 'mcp'
}

function now() {
  return new Date().toISOString()
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function laneDocument(runId, lane, results) {
  const starts = results.map((result) => Date.parse(result.timing.started_at))
  const finishes = results.map((result) => Date.parse(result.timing.finished_at))
  const started = Math.min(...starts)
  const finished = Math.max(...finishes)
  return {
    run_id: runId,
    lane,
    started_at: new Date(started).toISOString(),
    finished_at: new Date(finished).toISOString(),
    duration_ms: finished - started,
    cases: results.sort((left, right) => left.case_id.localeCompare(right.case_id) || left.attempt - right.attempt)
  }
}

function writeLanes(runId, runRoot, resultsByLane) {
  for (const [lane, results] of resultsByLane) {
    if (results.length === 0) continue
    const document = laneDocument(runId, lane, results)
    assertSchema('lane-result', document)
    writeJson(path.join(runRoot, FOLDER_BY_LANE[lane], 'lane-result.json'), document)
  }
}

function locksConflict(left, right) {
  if (!left.mutates || !right.mutates) return false
  return left.resource_locks.some((lock) => right.resource_locks.includes(lock))
}

function selectSafeBatch(ready) {
  const batch = []
  for (const testCase of ready.sort((left, right) => left.id.localeCompare(right.id))) {
    if (!batch.some((selected) => locksConflict(selected, testCase))) batch.push(testCase)
  }
  return batch
}

async function executeInitialPlan(plan, runRoot, executors) {
  const pending = new Map(plan.cases.map((testCase) => [testCase.id, testCase]))
  const completed = new Map()
  const resultsByLane = new Map()
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((testCase) =>
      testCase.dependencies.every((dependency) => completed.has(dependency))
    )
    if (ready.length === 0) throw new Error('Plan has a dependency cycle or an unknown dependency')
    const batch = selectSafeBatch(ready)
    const results = await Promise.all(
      batch.map(async (testCase) => {
        const lane = LANE_BY_EXECUTOR[testCase.executor]
        const result = await executeCase(executors, testCase.executor, testCase, {
          attempt: 1,
          run_id: plan.run_id,
          run_root: runRoot,
          lane,
          dependency_results: Object.fromEntries(
            testCase.dependencies.map((dependency) => [dependency, completed.get(dependency)])
          )
        })
        return { testCase, lane, result }
      })
    )
    for (const { testCase, lane, result } of results) {
      pending.delete(testCase.id)
      completed.set(testCase.id, result)
      if (!resultsByLane.has(lane)) resultsByLane.set(lane, [])
      resultsByLane.get(lane).push(result)
    }
  }
  return { completed, resultsByLane }
}

function routerCase(planCase, attempts, completed) {
  const value = {
    case_id: planCase.id,
    mcp_trigger: planCase.mcp_trigger,
    attempts
  }
  if (planCase.api_counterpart_id) {
    const counterpart = completed.get(planCase.api_counterpart_id)
    value.api_counterpart = {
      status: counterpart?.status ?? 'NOT_RUN',
      same_business_invariant: true
    }
  }
  return value
}

export async function orchestrateRun({ plan, runRoot, executors }) {
  assertSchema('execution-plan', plan)
  assertExecutorMap(executors)
  const absoluteRunRoot = path.resolve(runRoot)
  fs.mkdirSync(absoluteRunRoot, { recursive: true })

  const { completed, resultsByLane } = await executeInitialPlan(plan, absoluteRunRoot, executors)
  const browserCases = plan.cases.filter((testCase) => testCase.channel === 'BROWSER')
  if (browserCases.length > 0) {
    const browserResults = resultsByLane.get('PLAYWRIGHT_TEST') ?? []
    let routerCases = browserCases.map((testCase) =>
      routerCase(testCase, browserResults.filter((result) => result.case_id === testCase.id), completed)
    )
    let router = routeInput({
      run_id: plan.run_id,
      artifacts_root: absoluteRunRoot,
      expected_case_ids: browserCases.map((testCase) => testCase.id),
      cases: routerCases
    })

    for (const decision of router.decisions.filter((item) => item.next_action === 'REPLAY_ONCE')) {
      const testCase = browserCases.find((item) => item.id === decision.case_id)
      const result = await executeCase(executors, 'PLAYWRIGHT_TEST', testCase, {
        attempt: 2,
        run_id: plan.run_id,
        run_root: absoluteRunRoot,
        lane: 'PLAYWRIGHT_TEST',
        replay: true,
        previous_result: completed.get(testCase.id)
      })
      browserResults.push(result)
      completed.set(testCase.id, result)
    }

    routerCases = browserCases.map((testCase) =>
      routerCase(testCase, browserResults.filter((result) => result.case_id === testCase.id), completed)
    )
    router = routeInput({
      run_id: plan.run_id,
      artifacts_root: absoluteRunRoot,
      expected_case_ids: browserCases.map((testCase) => testCase.id),
      cases: routerCases
    })
    writeJson(path.join(absoluteRunRoot, 'router', 'decisions.json'), router)

    const mcpRequests = router.decisions.filter((decision) => decision.next_action === 'START_MCP')
    if (mcpRequests.length > 0) {
      const mcpResults = []
      for (const decision of mcpRequests) {
        const testCase = browserCases.find((item) => item.id === decision.case_id)
        if (typeof executors.MCP_DIAGNOSTIC === 'function') {
          mcpResults.push(
            await executeCase(executors, 'MCP_DIAGNOSTIC', testCase, {
              attempt: 1,
              run_id: plan.run_id,
              run_root: absoluteRunRoot,
              lane: 'MCP_DIAGNOSTIC',
              authorization: decision
            })
          )
        } else {
          const startedAt = now()
          mcpResults.push({
            case_id: testCase.id,
            attempt: 1,
            status: 'BLOCKED',
            timing: { started_at: startedAt, finished_at: startedAt, duration_ms: 0 },
            blocked: {
              code: 'DIAGNOSTIC_UNAVAILABLE',
              detail: 'Router authorized MCP diagnostics, but no MCP_DIAGNOSTIC executor was configured.'
            }
          })
        }
      }
      resultsByLane.set('MCP_DIAGNOSTIC', mcpResults)
    }
  }

  writeLanes(plan.run_id, absoluteRunRoot, resultsByLane)
  return {
    run_id: plan.run_id,
    run_root: absoluteRunRoot,
    finished_at: now(),
    lanes: [...resultsByLane.keys()]
  }
}
