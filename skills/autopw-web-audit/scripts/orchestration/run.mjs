import fs from 'node:fs'
import path from 'node:path'

import { assertSchema } from '../lib/schema-validator.mjs'
import { executeCase, assertExecutorMap } from '../executors/index.mjs'
import { routeInput } from '../router/index.mjs'
import { EvidenceImporter } from '../evidence/import.mjs'
import {
  ProcessRegistry,
  assertManagedPortsAvailable,
  createAttemptIsolation,
  createRunIsolation
} from '../runtime/process-registry.mjs'
import { CheckpointStore, executionFingerprint } from './checkpoint.mjs'
import { AuditSession } from './session.mjs'

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

async function executeInitialPlan(plan, runRoot, executors, checkpoint, runtime) {
  const pending = new Map(plan.cases.map((testCase) => [testCase.id, testCase]))
  const completed = new Map()
  const resultsByLane = new Map()
  for (const { lane, result } of checkpoint.entries()) {
    if (lane === 'MCP_DIAGNOSTIC') continue
    if (!resultsByLane.has(lane)) resultsByLane.set(lane, [])
    resultsByLane.get(lane).push(result)
    if (result.attempt === 1) {
      pending.delete(result.case_id)
      completed.set(result.case_id, result)
    }
  }
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((testCase) =>
      testCase.dependencies.every((dependency) => completed.has(dependency))
    )
    if (ready.length === 0) throw new Error('Plan has a dependency cycle or an unknown dependency')
    const batch = selectSafeBatch(ready)
    const settled = await Promise.allSettled(
      batch.map(async (testCase) => {
        const lane = LANE_BY_EXECUTOR[testCase.executor]
        const result = await executeCase(executors, testCase.executor, testCase, {
          attempt: 1,
          run_id: plan.run_id,
          run_root: runRoot,
          lane,
          runtime: {
            ...runtime,
            isolation: createAttemptIsolation(runtime.isolation, 1, runRoot)
          },
          batch_cases: batch,
          dependency_results: Object.fromEntries(
            testCase.dependencies.map((dependency) => [dependency, completed.get(dependency)])
          )
        })
        return { testCase, lane, result }
      })
    )
    const results = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value)
    for (const { testCase, lane, result } of results) {
      pending.delete(testCase.id)
      completed.set(testCase.id, result)
      if (!resultsByLane.has(lane)) resultsByLane.set(lane, [])
      resultsByLane.get(lane).push(result)
      checkpoint.record(lane, result)
    }
    const rejected = settled.find((item) => item.status === 'rejected')
    if (rejected) throw rejected.reason
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

export async function orchestrateRun({
  plan,
  runRoot,
  executors,
  lifecycle = {},
  resume = false,
  executorFingerprint = '',
  runtime: providedRuntime = null,
  mcpStagingRoots = []
}) {
  assertSchema('execution-plan', plan)
  assertExecutorMap(executors)
  const absoluteRunRoot = path.resolve(runRoot)
  fs.mkdirSync(absoluteRunRoot, { recursive: true })
  const checkpoint = new CheckpointStore({
    runRoot: absoluteRunRoot,
    runId: plan.run_id,
    fingerprint: executionFingerprint(plan, executorFingerprint),
    resume
  })
  const processRegistry = providedRuntime?.process_registry ?? new ProcessRegistry({ runRoot: absoluteRunRoot })
  const isolation = providedRuntime?.isolation ?? createRunIsolation(plan, absoluteRunRoot)
  const evidenceImporter = providedRuntime?.evidence_importer ?? new EvidenceImporter({
    runRoot: absoluteRunRoot,
    sourceRoots: mcpStagingRoots
  })
  const session = new AuditSession({
    runRoot: absoluteRunRoot,
    runId: plan.run_id,
    resumed: checkpoint.resumed,
    previousUpdatedAt: checkpoint.previousUpdatedAt
  })
  const runtime = {
    ...providedRuntime,
    process_registry: processRegistry,
    spawn: (command, args = [], options = {}) => processRegistry.spawn(command, args, {
      ...options,
      env: { ...process.env, ...isolation.env, ...(options.env ?? {}) }
    }),
    isolation,
    evidence_importer: evidenceImporter,
    session
  }
  let resultsByLane = new Map()
  let failure = null
  let cleanupSummary = []
  try {
    await session.phase('setup', async () => {
      if (checkpoint.resumed) processRegistry.recoverOwnedProcesses()
      await assertManagedPortsAvailable(plan.environment.services)
      if (typeof lifecycle.setup === 'function') await lifecycle.setup({ plan, runRoot: absoluteRunRoot, runtime })
    })
    const initial = await session.phase('initial_execution', () =>
      executeInitialPlan(plan, absoluteRunRoot, executors, checkpoint, runtime)
    )
    const { completed } = initial
    resultsByLane = initial.resultsByLane
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

      await session.phase('clean_replay', async () => {
        for (const decision of router.decisions.filter((item) => item.next_action === 'REPLAY_ONCE')) {
          const testCase = browserCases.find((item) => item.id === decision.case_id)
          let result = checkpoint.find('PLAYWRIGHT_TEST', testCase.id, 2)
          if (!result) {
            result = await executeCase(executors, 'PLAYWRIGHT_TEST', testCase, {
              attempt: 2,
              run_id: plan.run_id,
              run_root: absoluteRunRoot,
              lane: 'PLAYWRIGHT_TEST',
              replay: true,
              runtime: {
                ...runtime,
                isolation: createAttemptIsolation(runtime.isolation, 2, absoluteRunRoot)
              },
              batch_cases: [testCase],
              previous_result: completed.get(testCase.id)
            })
            checkpoint.record('PLAYWRIGHT_TEST', result)
          }
          if (!browserResults.some((item) => item.case_id === result.case_id && item.attempt === 2)) {
            browserResults.push(result)
          }
          completed.set(testCase.id, result)
        }
      })

      routerCases = browserCases.map((testCase) =>
        routerCase(testCase, browserResults.filter((result) => result.case_id === testCase.id), completed)
      )
      router = await session.phase('router', async () => routeInput({
        run_id: plan.run_id,
        artifacts_root: absoluteRunRoot,
        expected_case_ids: browserCases.map((testCase) => testCase.id),
        cases: routerCases
      }))
      writeJson(path.join(absoluteRunRoot, 'router', 'decisions.json'), router)

      const mcpRequests = router.decisions.filter((decision) => decision.next_action === 'START_MCP')
      if (mcpRequests.length > 0) {
        const mcpResults = checkpoint.results('MCP_DIAGNOSTIC')
        await session.phase('mcp_diagnostic', async () => {
          for (const decision of mcpRequests) {
            const testCase = browserCases.find((item) => item.id === decision.case_id)
            if (mcpResults.some((item) => item.case_id === testCase.id)) continue
            let result
            if (typeof executors.MCP_DIAGNOSTIC === 'function') {
              result = await executeCase(executors, 'MCP_DIAGNOSTIC', testCase, {
                attempt: 1,
                run_id: plan.run_id,
                run_root: absoluteRunRoot,
                lane: 'MCP_DIAGNOSTIC',
                runtime,
                evidence_importer: evidenceImporter,
                authorization: decision
              })
            } else {
              const startedAt = now()
              result = {
                case_id: testCase.id,
                attempt: 1,
                status: 'BLOCKED',
                timing: { started_at: startedAt, finished_at: startedAt, duration_ms: 0 },
                blocked: {
                  code: 'DIAGNOSTIC_UNAVAILABLE',
                  detail: 'Router authorized MCP diagnostics, but no MCP_DIAGNOSTIC executor was configured.'
                }
              }
            }
            mcpResults.push(result)
            checkpoint.record('MCP_DIAGNOSTIC', result)
          }
        })
        resultsByLane.set('MCP_DIAGNOSTIC', mcpResults)
      }
    }

    await session.phase('artifact_write', async () => writeLanes(plan.run_id, absoluteRunRoot, resultsByLane))
  } catch (error) {
    failure = error
  } finally {
    try {
      cleanupSummary = await session.phase('cleanup', async () => {
        let lifecycleResult = null
        let lifecycleError = null
        try {
          if (typeof lifecycle.cleanup === 'function') {
            lifecycleResult = await lifecycle.cleanup({
              plan,
              runRoot: absoluteRunRoot,
              runtime,
              error: failure
            })
          }
        } catch (error) {
          lifecycleError = error
        }
        const processes = await processRegistry.cleanup()
        evidenceImporter.persist()
        if (lifecycleError) throw lifecycleError
        return { lifecycle: lifecycleResult, processes }
      })
    } catch (cleanupError) {
      if (!failure) failure = cleanupError
      else failure.cleanup_error = cleanupError.message
    }
  }
  const sessionDocument = session.finish(failure ? 'FAIL' : 'PASS', { cleanup: cleanupSummary })
  if (failure) throw failure
  return {
    run_id: plan.run_id,
    run_root: absoluteRunRoot,
    started_at: sessionDocument.started_at,
    finished_at: sessionDocument.finished_at,
    duration_ms: sessionDocument.duration_ms,
    resumed: checkpoint.resumed,
    lanes: [...resultsByLane.keys()],
    session: path.relative(absoluteRunRoot, session.filePath).split(path.sep).join('/')
  }
}
