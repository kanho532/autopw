import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { orchestrateRun } from '../autopw-run.mjs'
import { routeCase } from '../autopw-router.mjs'
import { validateRun } from '../autopw-validate.mjs'

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function timing(second = 1, duration = 100) {
  const started = Date.parse(`2026-08-18T00:00:${String(second).padStart(2, '0')}.000Z`)
  return {
    started_at: new Date(started).toISOString(),
    finished_at: new Date(started + duration).toISOString(),
    duration_ms: duration
  }
}

function context(overrides = {}) {
  return {
    runner: 'PLAYWRIGHT_TEST',
    runner_version: '1.62.1',
    browser: 'chromium',
    browser_build: '1234',
    viewport: { width: 1280, height: 720 },
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    spec_path: 'generated/audit.spec.mjs',
    test_title: 'BROWSER-001 lifecycle',
    storage_state_contract: 'anonymous',
    steps: ['访问页面'],
    assertions: ['按钮可见'],
    locator_contract: ["getByRole('button')"],
    ...overrides
  }
}

function signature(overrides = {}) {
  return {
    case_id: 'BROWSER-001',
    failure_type: 'LOCATOR',
    route: '/',
    assertion: '按钮可见',
    locator: "getByRole('button')",
    http_method: null,
    http_status: null,
    top_stack_frame: 'generated/audit.spec.mjs:10',
    ...overrides
  }
}

function browserPlan(root) {
  return {
    run_id: 'run-integration',
    scope_mode: 'FULL',
    frozen_at: '2026-08-18T00:00:00.000Z',
    target: { repository: root, head: 'HEAD', worktree_status: [] },
    environment: { timezone: 'UTC', locale: 'zh-CN', services: [], playwright: {} },
    cases: [
      {
        id: 'BROWSER-001',
        channel: 'BROWSER',
        executor: 'PLAYWRIGHT_TEST',
        source: {},
        preconditions: [],
        steps: ['访问页面'],
        assertions: ['按钮可见'],
        evidence_contract: ['trace'],
        dependencies: [],
        resource_locks: ['browser_context'],
        mutates: false,
        cleanup: [],
        mcp_trigger: 'PLAYWRIGHT_FAILS_WITH_INCOMPLETE_EVIDENCE'
      }
    ]
  }
}

function failAttempt(attempt, overrides = {}) {
  return {
    case_id: 'BROWSER-001',
    attempt,
    status: 'FAIL',
    failure_type: 'LOCATOR',
    expected: '按钮可见',
    actual: '按钮不存在',
    failure_signature: signature(),
    evidence: {
      final_url: 'http://localhost/',
      screenshot: 'playwright/screenshot.png',
      trace: 'playwright/trace.zip'
    },
    timing: timing(attempt),
    execution_context: context(),
    isolation_id: `isolation-${attempt}`,
    ...overrides
  }
}

test('orchestrator closes FAIL -> replay PASS as FLAKY', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-orchestrator-'))
  const runRoot = path.join(root, 'runs', 'run-integration')
  const plan = browserPlan(root)
  const executors = {
    PLAYWRIGHT_TEST: async (_testCase, execution) => {
      fs.mkdirSync(path.join(runRoot, 'playwright'), { recursive: true })
      fs.writeFileSync(path.join(runRoot, 'playwright', 'screenshot.png'), 'image')
      fs.writeFileSync(path.join(runRoot, 'playwright', 'trace.zip'), 'trace')
      if (execution.attempt === 1) return failAttempt(1)
      return {
        case_id: 'BROWSER-001',
        attempt: 2,
        status: 'PASS',
        evidence: { artifact: 'playwright/trace.zip' },
        timing: timing(2),
        execution_context: context(),
        isolation_id: 'isolation-2'
      }
    }
  }
  await orchestrateRun({ plan, runRoot, executors })
  const router = JSON.parse(fs.readFileSync(path.join(runRoot, 'router', 'decisions.json'), 'utf8'))
  const lane = JSON.parse(fs.readFileSync(path.join(runRoot, 'playwright', 'lane-result.json'), 'utf8'))
  assert.equal(router.decisions[0].next_action, 'DONE')
  assert.equal(router.decisions[0].final_status, 'FLAKY')
  assert.deepEqual(lane.cases.map((result) => result.attempt), [1, 2])
})

test('same replay failure with incomplete evidence authorizes MCP', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-router-lifecycle-'))
  for (const file of ['screenshot.png', 'trace.zip']) fs.writeFileSync(path.join(root, file), file)
  const first = failAttempt(1, { evidence: { final_url: '/', screenshot: 'screenshot.png', trace: 'trace.zip' } })
  const second = failAttempt(2, { evidence: { final_url: '/', screenshot: 'screenshot.png', trace: 'trace.zip' } })
  const decision = routeCase(
    { case_id: 'BROWSER-001', mcp_trigger: 'PLAYWRIGHT_FAILS_WITH_INCOMPLETE_EVIDENCE', attempts: [first, second] },
    root
  )
  assert.equal(decision.next_action, 'START_MCP')
})

test('orchestrator records structured BLOCKED when authorized MCP is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-mcp-unavailable-'))
  const runRoot = path.join(root, 'runs', 'run-integration')
  const plan = browserPlan(root)
  const executors = {
    PLAYWRIGHT_TEST: async (_testCase, execution) => {
      fs.mkdirSync(path.join(runRoot, 'playwright'), { recursive: true })
      fs.writeFileSync(path.join(runRoot, 'playwright', 'screenshot.png'), 'image')
      fs.writeFileSync(path.join(runRoot, 'playwright', 'trace.zip'), 'trace')
      return failAttempt(execution.attempt)
    }
  }
  await orchestrateRun({ plan, runRoot, executors })
  const diagnostic = JSON.parse(fs.readFileSync(path.join(runRoot, 'mcp', 'lane-result.json'), 'utf8'))
  assert.equal(diagnostic.cases[0].status, 'BLOCKED')
  assert.equal(diagnostic.cases[0].blocked.code, 'DIAGNOSTIC_UNAVAILABLE')
})

test('replay browser build change is INVALID_RESULT', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-router-context-'))
  const decision = routeCase(
    {
      case_id: 'BROWSER-001',
      mcp_trigger: 'PLAYWRIGHT_FAILS_WITH_INCOMPLETE_EVIDENCE',
      attempts: [failAttempt(1), failAttempt(2, { execution_context: context({ browser_build: '5678' }) })]
    },
    root
  )
  assert.equal(decision.next_action, 'INVALID_RESULT')
  assert.equal(decision.reason_code, 'REPLAY.CONTEXT_CHANGED')
})

function apiCase(id) {
  return {
    id,
    channel: 'API',
    executor: 'DIRECT_API',
    source: {},
    preconditions: [],
    steps: ['请求接口'],
    assertions: ['响应正确'],
    evidence_contract: ['artifact'],
    dependencies: [],
    resource_locks: [],
    mutates: false,
    cleanup: [],
    mcp_trigger: 'NONE'
  }
}

function report(ids, counts) {
  return `# Report\n\n${ids.join('\n\n')}\n\n| 用例状态 | 数量 |\n|---|---:|\n| 通过 | ${counts.PASS} |\n| 失败/发现问题 | ${counts.FAIL} |\n| 阻塞 | ${counts.BLOCKED} |\n| 未执行/超出范围 | ${counts.NOT_RUN} |\n| 不稳定 | ${counts.FLAKY} |\n\n[plan](execution-plan.json)\n`
}

test('ten planned cases with one explicit NOT_RUN form a valid audit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-ten-cases-'))
  const runRoot = path.join(root, 'runs', 'run-ten')
  const ids = Array.from({ length: 10 }, (_, index) => `API-${String(index + 1).padStart(3, '0')}`)
  const plan = {
    run_id: 'run-ten',
    scope_mode: 'FULL',
    frozen_at: '2026-08-18T00:00:00.000Z',
    target: { repository: root, head: 'HEAD', worktree_status: [] },
    environment: { timezone: 'UTC', locale: 'zh-CN', services: [], playwright: {} },
    cases: ids.map(apiCase)
  }
  const results = ids.map((id, index) => {
    if (index === 9) {
      return {
        case_id: id,
        attempt: 1,
        status: 'NOT_RUN',
        timing: timing(1),
        not_run: { code: 'MISSING_CREDENTIAL', detail: '缺少第十个用例的测试账号' }
      }
    }
    const artifact = `api/${id}.json`
    writeJson(path.join(runRoot, artifact), { ok: true })
    return { case_id: id, attempt: 1, status: 'PASS', timing: timing(1), evidence: { artifact } }
  })
  writeJson(path.join(root, 'execution-plan.json'), plan)
  writeJson(path.join(runRoot, 'api', 'lane-result.json'), {
    run_id: 'run-ten',
    lane: 'API',
    ...timing(1),
    cases: results
  })
  fs.writeFileSync(path.join(root, 'report.md'), report(ids, { PASS: 9, FAIL: 0, BLOCKED: 0, NOT_RUN: 1, FLAKY: 0 }))
  const result = validateRun({
    planPath: path.join(root, 'execution-plan.json'),
    runRoot,
    reportPath: path.join(root, 'report.md')
  })
  assert.equal(result.valid, true)
})

test('artifact outside run root is rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-outside-'))
  const runRoot = path.join(root, 'runs', 'run-outside')
  const outside = path.join(root, 'outside.json')
  writeJson(outside, { secret: false })
  const id = 'API-001'
  const plan = {
    run_id: 'run-outside',
    scope_mode: 'FULL',
    frozen_at: '2026-08-18T00:00:00.000Z',
    target: { repository: root, head: 'HEAD', worktree_status: [] },
    environment: { timezone: 'UTC', locale: 'zh-CN', services: [], playwright: {} },
    cases: [apiCase(id)]
  }
  writeJson(path.join(root, 'execution-plan.json'), plan)
  writeJson(path.join(runRoot, 'api', 'lane-result.json'), {
    run_id: 'run-outside', lane: 'API', ...timing(1),
    cases: [{ case_id: id, attempt: 1, status: 'PASS', timing: timing(1), evidence: { artifact: outside } }]
  })
  fs.writeFileSync(path.join(root, 'report.md'), report([id], { PASS: 1, FAIL: 0, BLOCKED: 0, NOT_RUN: 0, FLAKY: 0 }))
  const result = validateRun({ planPath: path.join(root, 'execution-plan.json'), runRoot, reportPath: path.join(root, 'report.md') })
  assert.ok(result.errors.some((error) => error.code === 'ARTIFACT.OUTSIDE_RUN_ROOT'))
})

test('MCP evidence without router authorization rejects the run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-unauthorized-mcp-'))
  const runRoot = path.join(root, 'runs', 'run-integration')
  const plan = browserPlan(root)
  writeJson(path.join(root, 'execution-plan.json'), plan)
  writeJson(path.join(runRoot, 'playwright', 'pass.json'), { ok: true })
  writeJson(path.join(runRoot, 'mcp', 'diagnostic.json'), { should_not_run: true })
  writeJson(path.join(runRoot, 'playwright', 'lane-result.json'), {
    run_id: plan.run_id, lane: 'PLAYWRIGHT_TEST', ...timing(1),
    cases: [{ case_id: 'BROWSER-001', attempt: 1, status: 'PASS', timing: timing(1), evidence: { artifact: 'playwright/pass.json' } }]
  })
  writeJson(path.join(runRoot, 'mcp', 'lane-result.json'), {
    run_id: plan.run_id, lane: 'MCP_DIAGNOSTIC', ...timing(2),
    cases: [{ case_id: 'BROWSER-001', attempt: 1, status: 'PASS', timing: timing(2), evidence: { artifact: 'mcp/diagnostic.json' } }]
  })
  writeJson(path.join(runRoot, 'router', 'decisions.json'), {
    run_id: plan.run_id,
    decisions: [{ case_id: 'BROWSER-001', next_action: 'DONE', final_status: 'PASS', reason_code: 'EXECUTION.PASSED' }]
  })
  fs.writeFileSync(path.join(root, 'report.md'), report(['BROWSER-001'], { PASS: 1, FAIL: 0, BLOCKED: 0, NOT_RUN: 0, FLAKY: 0 }))
  const result = validateRun({ planPath: path.join(root, 'execution-plan.json'), runRoot, reportPath: path.join(root, 'report.md') })
  assert.ok(result.errors.some((error) => error.code === 'MCP.UNAUTHORIZED_EXECUTION'))
})
