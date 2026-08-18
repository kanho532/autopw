import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { validateRun } from '../autopw-validate.mjs'

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function timing(started = '2026-08-17T00:00:01.000Z', duration = 100) {
  return {
    started_at: started,
    finished_at: new Date(Date.parse(started) + duration).toISOString(),
    duration_ms: duration
  }
}

function planCase(id, channel, executor) {
  return {
    id,
    channel,
    executor,
    source: {},
    preconditions: [],
    steps: ['step'],
    assertions: ['assertion'],
    evidence_contract: ['artifact'],
    dependencies: [],
    resource_locks: [],
    mutates: false,
    cleanup: [],
    mcp_trigger: channel === 'BROWSER' ? 'PLAYWRIGHT_FAILS_WITH_INCOMPLETE_EVIDENCE' : 'NONE'
  }
}

function reportText({ PASS, FAIL, BLOCKED = 0, NOT_RUN = 0, FLAKY = 0 }) {
  return `# Report

API-001

BROWSER-001

| 用例状态 | 数量 |
|---|---:|
| 通过 | ${PASS} |
| 失败/发现问题 | ${FAIL} |
| 阻塞 | ${BLOCKED} |
| 未执行/超出范围 | ${NOT_RUN} |
| 不稳定 | ${FLAKY} |

[plan](execution-plan.json)
`
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-validate-'))
  const runRoot = path.join(root, 'runs', 'run-1')
  const planPath = path.join(root, 'execution-plan.json')
  const reportPath = path.join(root, 'report.md')
  const plan = {
    run_id: 'run-1',
    scope_mode: 'FULL',
    frozen_at: '2026-08-17T00:00:00.000Z',
    target: { repository: root, head: 'HEAD', worktree_status: [] },
    environment: { timezone: 'UTC', locale: 'zh-CN', services: [], playwright: {} },
    cases: [
      planCase('API-001', 'API', 'DIRECT_API'),
      planCase('BROWSER-001', 'BROWSER', 'PLAYWRIGHT_TEST')
    ]
  }
  const apiLane = {
    run_id: 'run-1',
    lane: 'API',
    ...timing(),
    cases: [
      {
        case_id: 'API-001',
        attempt: 1,
        status: 'PASS',
        timing: timing(),
        evidence: { artifact: 'api/api-001.json' }
      }
    ]
  }
  const browserLane = {
    run_id: 'run-1',
    lane: 'PLAYWRIGHT_TEST',
    ...timing('2026-08-17T00:00:02.000Z'),
    cases: [
      {
        case_id: 'BROWSER-001',
        attempt: 1,
        status: 'PASS',
        timing: timing('2026-08-17T00:00:02.000Z'),
        evidence: { artifact: 'playwright/browser-001.json' }
      }
    ]
  }
  const router = {
    run_id: 'run-1',
    decisions: [
      { case_id: 'BROWSER-001', next_action: 'DONE', final_status: 'PASS', reason_code: 'EXECUTION.PASSED' }
    ]
  }

  writeJson(planPath, plan)
  writeJson(path.join(runRoot, 'api', 'lane-result.json'), apiLane)
  writeJson(path.join(runRoot, 'playwright', 'lane-result.json'), browserLane)
  writeJson(path.join(runRoot, 'router', 'decisions.json'), router)
  writeJson(path.join(runRoot, 'api', 'api-001.json'), { ok: true })
  writeJson(path.join(runRoot, 'playwright', 'browser-001.json'), { ok: true })
  fs.writeFileSync(reportPath, reportText({ PASS: 2, FAIL: 0 }), 'utf8')
  return { root, runRoot, planPath, reportPath, plan, apiLane, browserLane, router }
}

function validate(fixture) {
  return validateRun({
    planPath: fixture.planPath,
    runRoot: fixture.runRoot,
    reportPath: fixture.reportPath
  })
}

test('accepts a complete deterministic audit run', () => {
  const fixture = createFixture()
  const result = validate(fixture)
  assert.equal(result.valid, true)
  assert.deepEqual(result.summary, {
    planned: 2,
    PASS: 2,
    FAIL: 0,
    BLOCKED: 0,
    NOT_RUN: 0,
    FLAKY: 0,
    lanes: 2,
    artifacts_checked: 2,
    report_links_checked: 1
  })
})

test('rejects duplicate frozen plan ids', () => {
  const fixture = createFixture()
  fixture.plan.cases.push(planCase('API-001', 'API', 'DIRECT_API'))
  writeJson(fixture.planPath, fixture.plan)
  const result = validate(fixture)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.code === 'PLAN.DUPLICATE_CASE'))
})

test('rejects plan ids outside the frozen id namespace', () => {
  const fixture = createFixture()
  fixture.plan.cases[0].id = 'OTHER-001'
  writeJson(fixture.planPath, fixture.plan)
  const result = validate(fixture)
  assert.ok(result.errors.some((error) => error.code === 'PLAN.INVALID_SCHEMA'))
})

test('rejects missing case results and records NOT_RUN', () => {
  const fixture = createFixture()
  fixture.apiLane.cases = []
  writeJson(path.join(fixture.runRoot, 'api', 'lane-result.json'), fixture.apiLane)
  const result = validate(fixture)
  assert.equal(result.final_statuses['API-001'], 'NOT_RUN')
  assert.ok(result.errors.some((error) => error.code === 'EXECUTION.MISSING_RESULT'))
})

test('accepts an explicit structured NOT_RUN result', () => {
  const fixture = createFixture()
  fixture.apiLane.cases[0] = {
    case_id: 'API-001',
    attempt: 1,
    status: 'NOT_RUN',
    timing: timing(),
    not_run: { code: 'MISSING_CREDENTIAL', detail: '测试账号未提供' }
  }
  writeJson(path.join(fixture.runRoot, 'api', 'lane-result.json'), fixture.apiLane)
  fs.writeFileSync(fixture.reportPath, reportText({ PASS: 1, FAIL: 0, NOT_RUN: 1 }), 'utf8')
  const result = validate(fixture)
  assert.equal(result.valid, true)
  assert.equal(result.final_statuses['API-001'], 'NOT_RUN')
})

test('rejects missing evidence artifacts and report links', () => {
  const fixture = createFixture()
  fs.rmSync(path.join(fixture.runRoot, 'api', 'api-001.json'))
  fs.appendFileSync(fixture.reportPath, '\n[missing](missing.json)\n', 'utf8')
  const result = validate(fixture)
  assert.ok(result.errors.some((error) => error.code === 'ARTIFACT.MISSING'))
  assert.ok(result.errors.some((error) => error.code === 'REPORT.MISSING_LINK'))
})

test('rejects report counts that differ from validated results', () => {
  const fixture = createFixture()
  const report = reportText({ PASS: 1, FAIL: 1 })
  fs.writeFileSync(fixture.reportPath, report, 'utf8')
  const result = validate(fixture)
  assert.ok(result.errors.some((error) => error.code === 'REPORT.COUNT_MISMATCH'))
})

test('rejects a non-terminal replay decision', () => {
  const fixture = createFixture()
  fixture.router.decisions[0].next_action = 'REPLAY_ONCE'
  delete fixture.router.decisions[0].final_status
  fixture.router.decisions[0].reason_code = 'EVIDENCE.INCOMPLETE'
  writeJson(path.join(fixture.runRoot, 'router', 'decisions.json'), fixture.router)
  const result = validate(fixture)
  assert.ok(result.errors.some((error) => error.code === 'ROUTER.NON_TERMINAL_ACTION'))
})

test('rejects execution that started before the plan freeze', () => {
  const fixture = createFixture()
  fixture.plan.frozen_at = '2026-08-17T00:00:10.000Z'
  writeJson(fixture.planPath, fixture.plan)
  const result = validate(fixture)
  assert.ok(result.errors.some((error) => error.code === 'EXECUTION.BEFORE_FREEZE'))
})

test('requires an MCP diagnostic result after START_MCP', () => {
  const fixture = createFixture()
  fixture.browserLane.cases[0].status = 'FAIL'
  fixture.browserLane.cases[0].failure_type = 'LOCATOR'
  fixture.router.decisions[0].next_action = 'START_MCP'
  delete fixture.router.decisions[0].final_status
  fixture.router.decisions[0].reason_code = 'MCP.SAME_FAILURE_EVIDENCE_INCOMPLETE'
  writeJson(path.join(fixture.runRoot, 'playwright', 'lane-result.json'), fixture.browserLane)
  writeJson(path.join(fixture.runRoot, 'router', 'decisions.json'), fixture.router)
  fs.writeFileSync(fixture.reportPath, reportText({ PASS: 1, FAIL: 1 }), 'utf8')
  const result = validate(fixture)
  assert.ok(result.errors.some((error) => error.code === 'MCP.MISSING_RESULT'))
})

test('accepts START_MCP only after a matching diagnostic lane closes it', () => {
  const fixture = createFixture()
  fixture.browserLane.cases[0].status = 'FAIL'
  fixture.browserLane.cases[0].failure_type = 'LOCATOR'
  fixture.router.decisions[0].next_action = 'START_MCP'
  delete fixture.router.decisions[0].final_status
  fixture.router.decisions[0].reason_code = 'MCP.SAME_FAILURE_EVIDENCE_INCOMPLETE'
  writeJson(path.join(fixture.runRoot, 'playwright', 'lane-result.json'), fixture.browserLane)
  writeJson(path.join(fixture.runRoot, 'router', 'decisions.json'), fixture.router)
  writeJson(path.join(fixture.runRoot, 'mcp', 'mcp-evidence.json'), { diagnosed: true })
  writeJson(path.join(fixture.runRoot, 'mcp', 'lane-result.json'), {
    run_id: 'run-1',
    lane: 'MCP_DIAGNOSTIC',
    ...timing('2026-08-17T00:00:03.000Z'),
    cases: [
      {
        case_id: 'BROWSER-001',
        attempt: 1,
        status: 'PASS',
        timing: timing('2026-08-17T00:00:03.000Z'),
        evidence: { artifact: 'mcp/mcp-evidence.json' }
      }
    ]
  })
  fs.writeFileSync(fixture.reportPath, reportText({ PASS: 1, FAIL: 1 }), 'utf8')
  const result = validate(fixture)
  assert.equal(result.valid, true)
  assert.equal(result.final_statuses['BROWSER-001'], 'FAIL')
})
