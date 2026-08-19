import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createPlaywrightExecutor } from '../executors/playwright.mjs'

function browserCase(id, specPath) {
  return {
    id,
    title: `${id} browser flow`,
    channel: 'BROWSER',
    executor: 'PLAYWRIGHT_TEST',
    source: { spec_path: specPath },
    preconditions: [],
    steps: ['Open page'],
    assertions: ['Page is usable'],
    evidence_contract: ['screenshot'],
    dependencies: [],
    resource_locks: [],
    mutates: false,
    cleanup: [],
    mcp_trigger: 'NONE',
    locator_contract: [{ strategy: 'TEST_ID', value: 'submit', unique: true }]
  }
}

test('built-in Playwright executor batches one list and one run per attempt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-executor-'))
  const runRoot = path.join(root, 'run')
  const generated = path.join(runRoot, 'playwright', 'generated')
  fs.mkdirSync(generated, { recursive: true })
  const firstSpec = path.join(generated, 'browser-001.spec.mjs')
  const secondSpec = path.join(generated, 'browser-002.spec.mjs')
  fs.writeFileSync(firstSpec, '')
  fs.writeFileSync(secondSpec, '')
  const plan = {
    run_id: 'executor-test',
    target: { repository: root },
    environment: { locale: 'zh-CN', timezone: 'Asia/Shanghai', playwright: { mode: 'AUTOPW_RUNTIME' } },
    cases: [browserCase('BROWSER-001', path.relative(runRoot, firstSpec)), browserCase('BROWSER-002', path.relative(runRoot, secondSpec))]
  }
  const calls = []
  const runner = async (options) => {
    calls.push(options.list ? 'list' : 'run')
    if (options.list) return { code: 0, stdout: '', stderr: '' }
    return {
      code: 0,
      runtime: { version: '1.62.1' },
      timings: {
        tests: [
          { case_id: 'BROWSER-001', title: 'BROWSER-001 browser flow', status: 'passed', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:00.010Z', duration_ms: 10 },
          { case_id: 'BROWSER-002', title: 'BROWSER-002 browser flow', status: 'failed', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:00.020Z', duration_ms: 20, errors: [{ message: 'expect failed', stack: 'at test (spec.mjs:1:1)', failure_type: 'ASSERTION' }] }
        ]
      }
    }
  }
  const executor = createPlaywrightExecutor({ plan, runRoot, runner })
  const context = { attempt: 1, run_id: plan.run_id, run_root: runRoot, runtime: { isolation: { data_prefix: 'autopw_executor_' } } }
  const results = await Promise.all(plan.cases.map((testCase) => executor(testCase, context)))

  assert.deepEqual(calls, ['list', 'run'])
  assert.equal(results[0].status, 'PASS')
  assert.equal(results[1].status, 'FAIL')
  assert.equal(results[1].failure_type, 'ASSERTION')
  assert.equal(results[0].execution_context.runner_version, '1.62.1')
  assert.equal(results[0].execution_context.spec_path, 'playwright/generated/browser-001.spec.mjs')
  assert.equal(results[0].isolation_id, 'autopw_executor_')
})
