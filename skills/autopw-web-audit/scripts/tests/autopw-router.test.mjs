import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  compareExecutionContexts,
  compareSignatures,
  routeCase,
  routeInput
} from '../autopw-router.mjs'
import { validateSchema } from '../lib/schema-validator.mjs'

function timing(attempt, duration = 100) {
  const started = new Date(`2026-08-17T03:20:${String(attempt).padStart(2, '0')}.000Z`)
  return {
    started_at: started.toISOString(),
    finished_at: new Date(started.getTime() + duration).toISOString(),
    duration_ms: duration
  }
}

function signature(overrides = {}) {
  return {
    case_id: 'BROWSER-001',
    failure_type: 'LOCATOR',
    route: '/login',
    assertion: '登录按钮可见',
    locator: "getByRole('button', { name: '登 录' })",
    http_method: null,
    http_status: null,
    top_stack_frame: 'generated/login.spec.ts:20',
    ...overrides
  }
}

function executionContext(overrides = {}) {
  return {
    runner: 'PLAYWRIGHT_TEST',
    runner_version: '1.62.1',
    browser: 'chromium',
    browser_build: '1234',
    viewport: { width: 1280, height: 720 },
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    spec_path: 'generated/login.spec.cjs',
    test_title: 'BROWSER-001 登录按钮可见',
    storage_state_contract: 'anonymous',
    steps: ['访问 /login'],
    assertions: ['登录按钮可见'],
    locator_contract: ["getByRole('button', { name: '登 录' })"],
    ...overrides
  }
}

function passAttempt(attempt = 1) {
  return {
    case_id: 'BROWSER-001',
    attempt,
    status: 'PASS',
    timing: timing(attempt),
    execution_context: executionContext(),
    isolation_id: `data-${attempt}`
  }
}

function failAttempt(attempt, evidence, signatureOverrides = {}) {
  return {
    case_id: 'BROWSER-001',
    attempt,
    status: 'FAIL',
    failure_type: 'LOCATOR',
    expected: '登录按钮可见',
    actual: '未定位到登录按钮',
    failure_signature: signature(signatureOverrides),
    evidence,
    timing: timing(attempt),
    execution_context: executionContext(),
    isolation_id: `data-${attempt}`
  }
}

function testCase(attempts, overrides = {}) {
  return {
    case_id: 'BROWSER-001',
    mcp_trigger: 'PLAYWRIGHT_FAILS_WITH_INCOMPLETE_EVIDENCE',
    attempts,
    ...overrides
  }
}

const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-router-'))
for (const name of ['dom.yml', 'trace.zip', 'screenshot.png']) {
  fs.writeFileSync(path.join(artifactsRoot, name), name)
}

const completeEvidence = {
  final_url: 'http://localhost:5173/login',
  dom_state: 'dom.yml',
  screenshot: 'screenshot.png',
  trace: 'trace.zip'
}

const incompleteEvidence = {
  final_url: 'http://localhost:5173/login',
  screenshot: 'screenshot.png',
  trace: 'trace.zip'
}

test('PASS is terminal and does not start MCP', () => {
  const decision = routeCase(testCase([passAttempt()]), artifactsRoot)
  assert.equal(decision.next_action, 'DONE')
  assert.equal(decision.final_status, 'PASS')
  assert.equal(decision.timing.total_duration_ms, 100)
})

test('complete failure evidence is terminal', () => {
  const decision = routeCase(testCase([failAttempt(1, completeEvidence)]), artifactsRoot)
  assert.equal(decision.next_action, 'DONE')
  assert.equal(decision.final_status, 'FAIL')
})

test('first incomplete failure replays exactly once', () => {
  const decision = routeCase(testCase([failAttempt(1, incompleteEvidence)]), artifactsRoot)
  assert.equal(decision.next_action, 'REPLAY_ONCE')
  assert.deepEqual(decision.missing_evidence, ['evidence.dom_state'])
})

test('clean replay pass is a flaky candidate', () => {
  const decision = routeCase(
    testCase([failAttempt(1, incompleteEvidence), passAttempt(2)]),
    artifactsRoot
  )
  assert.equal(decision.next_action, 'DONE')
  assert.equal(decision.final_status, 'FLAKY')
  assert.equal(decision.reason_code, 'REPLAY.PASSED')
  assert.equal(decision.timing.total_duration_ms, 200)
})

test('changed readable failure signature is a flaky candidate', () => {
  const decision = routeCase(
    testCase([
      failAttempt(1, incompleteEvidence),
      failAttempt(2, incompleteEvidence, { locator: "getByText('登录')" })
    ]),
    artifactsRoot
  )
  assert.equal(decision.next_action, 'DONE')
  assert.equal(decision.final_status, 'FLAKY')
  assert.deepEqual(decision.signature_differences, ['locator'])
})

test('same repeated failure with incomplete evidence starts MCP', () => {
  const decision = routeCase(
    testCase([failAttempt(1, incompleteEvidence), failAttempt(2, incompleteEvidence)]),
    artifactsRoot
  )
  assert.equal(decision.next_action, 'START_MCP')
  assert.equal(decision.reason_code, 'MCP.SAME_FAILURE_EVIDENCE_INCOMPLETE')
  assert.deepEqual(decision.failure_signature, signature())
})

test('API/browser mismatch still performs one clean replay first', () => {
  const firstDecision = routeCase(
    testCase([failAttempt(1, incompleteEvidence)], {
      mcp_trigger: 'API_BROWSER_MISMATCH',
      api_counterpart: { status: 'PASS', same_business_invariant: true }
    }),
    artifactsRoot
  )
  assert.equal(firstDecision.next_action, 'REPLAY_ONCE')

  const decision = routeCase(
    testCase([failAttempt(1, incompleteEvidence), failAttempt(2, incompleteEvidence)], {
      mcp_trigger: 'API_BROWSER_MISMATCH',
      api_counterpart: { status: 'PASS', same_business_invariant: true }
    }),
    artifactsRoot
  )
  assert.equal(decision.next_action, 'START_MCP')
  assert.equal(decision.reason_code, 'MCP.API_BROWSER_MISMATCH')
})

test('API/browser mismatch with a changed replay signature is flaky, not MCP', () => {
  const decision = routeCase(
    testCase(
      [
        failAttempt(1, incompleteEvidence),
        failAttempt(2, incompleteEvidence, { locator: "getByText('登录')" })
      ],
      {
        mcp_trigger: 'API_BROWSER_MISMATCH',
        api_counterpart: { status: 'PASS', same_business_invariant: true }
      }
    ),
    artifactsRoot
  )
  assert.equal(decision.next_action, 'DONE')
  assert.equal(decision.final_status, 'FLAKY')
})

test('MCP reason must exactly match the frozen trigger', () => {
  const decision = routeCase(
    testCase([failAttempt(1, incompleteEvidence), failAttempt(2, incompleteEvidence)], {
      mcp_trigger: 'API_BROWSER_MISMATCH'
    }),
    artifactsRoot
  )
  assert.equal(decision.next_action, 'DONE')
  assert.equal(decision.final_status, 'BLOCKED')
  assert.equal(decision.required_trigger, 'PLAYWRIGHT_FAILS_WITH_INCOMPLETE_EVIDENCE')
})

test('failure signature must contain every readable field', () => {
  const attempt = failAttempt(1, incompleteEvidence)
  delete attempt.failure_signature.route
  const decision = routeCase(testCase([attempt]), artifactsRoot)
  assert.equal(decision.next_action, 'INVALID_RESULT')
  assert.deepEqual(decision.missing_evidence, ['/attempts/0/failure_signature:required'])
})

test('MCP cannot start unless the trigger was frozen', () => {
  const decision = routeCase(
    testCase([failAttempt(1, incompleteEvidence), failAttempt(2, incompleteEvidence)], {
      mcp_trigger: 'NONE'
    }),
    artifactsRoot
  )
  assert.equal(decision.next_action, 'DONE')
  assert.equal(decision.final_status, 'BLOCKED')
})

test('infrastructure failure never starts MCP', () => {
  const decision = routeCase(
    testCase([
      {
        case_id: 'BROWSER-001',
        attempt: 1,
        status: 'FAIL',
        failure_type: 'INFRASTRUCTURE',
        failure_signature: signature({ failure_type: 'INFRASTRUCTURE' }),
        evidence: {
          infrastructure: {
            health_check: 'GET http://localhost:5173',
            command: 'npm run dev',
            exit_code: 1
          }
        },
        timing: timing(1),
        execution_context: executionContext(),
        isolation_id: 'data-1'
      }
    ]),
    artifactsRoot
  )
  assert.equal(decision.next_action, 'DONE')
  assert.equal(decision.final_status, 'BLOCKED')
})

test('timing inconsistency is rejected', () => {
  const attempt = passAttempt()
  attempt.timing.duration_ms = 9999
  const decision = routeCase(testCase([attempt]), artifactsRoot)
  assert.equal(decision.next_action, 'INVALID_RESULT')
  assert.equal(decision.reason_code, 'EXECUTION.INVALID_TIMING')
})

test('signature comparison is readable and normalizes whitespace', () => {
  const result = compareSignatures(signature(), signature({ assertion: '  登录按钮可见  ' }))
  assert.equal(result.same, true)
  assert.deepEqual(result.differences, [])
})

test('replay execution context is compared as readable fields', () => {
  const result = compareExecutionContexts(
    executionContext(),
    executionContext({ steps: ['访问 /login', '修改测试 setup'] })
  )
  assert.equal(result.same, false)
  assert.deepEqual(result.differences, ['steps'])
})

test('changed replay setup is invalid instead of flaky or MCP', () => {
  const first = failAttempt(1, incompleteEvidence)
  const second = passAttempt(2)
  second.execution_context = executionContext({ assertions: ['修正后的断言'] })
  const decision = routeCase(testCase([first, second]), artifactsRoot)
  assert.equal(decision.next_action, 'INVALID_RESULT')
  assert.equal(decision.reason_code, 'REPLAY.CONTEXT_CHANGED')
  assert.deepEqual(decision.context_differences, ['assertions'])
})

test('clean replay must use a new isolation id', () => {
  const first = failAttempt(1, incompleteEvidence)
  const second = passAttempt(2)
  second.isolation_id = first.isolation_id
  const decision = routeCase(testCase([first, second]), artifactsRoot)
  assert.equal(decision.next_action, 'INVALID_RESULT')
  assert.equal(decision.reason_code, 'REPLAY.CONTEXT_CHANGED')
  assert.equal(decision.isolation_reused, true)
})

test('same input produces the same routing output', () => {
  const input = {
    run_id: 'run-001',
    artifacts_root: artifactsRoot,
    expected_case_ids: ['BROWSER-001'],
    cases: [testCase([passAttempt()])]
  }
  assert.deepEqual(routeInput(input), routeInput(input))
})

test('empty, missing, duplicate or unexpected browser runs are rejected', () => {
  const base = { run_id: 'run-001', artifacts_root: artifactsRoot }
  assert.throws(
    () => routeInput({ ...base, expected_case_ids: ['BROWSER-001'], cases: [] }),
    /"missing":\["BROWSER-001"\]/
  )
  assert.throws(
    () =>
      routeInput({
        ...base,
        expected_case_ids: ['BROWSER-001'],
        cases: [testCase([passAttempt()]), testCase([passAttempt()])]
      }),
    /"duplicate_actual":\["BROWSER-001"\]/
  )
  assert.throws(
    () =>
      routeInput({
        ...base,
        expected_case_ids: ['BROWSER-002'],
        cases: [testCase([passAttempt()])]
      }),
    /"unexpected":\["BROWSER-001"\]/
  )
})

test('browser replay context is mandatory only in router input, not every evidence lane', () => {
  const attempt = passAttempt()
  delete attempt.execution_context
  delete attempt.isolation_id
  assert.equal(
    validateSchema('router-case', testCase([attempt])).valid,
    false
  )
  assert.equal(
    validateSchema('lane-result', {
      run_id: 'run-001',
      lane: 'PLAYWRIGHT_TEST',
      ...timing(1),
      cases: [{ ...attempt, evidence: { artifact: 'result.json' } }]
    }).valid,
    true
  )
})
