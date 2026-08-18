const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const Reporter = require('../autopw-playwright-reporter.cjs')

test('extracts a frozen case id from a Playwright title', () => {
  assert.equal(Reporter.extractCaseId('BROWSER-012 登录成功'), 'BROWSER-012')
  assert.equal(Reporter.extractCaseId('login succeeds'), null)
})

test('records start, finish, duration, result, errors and attachments', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-reporter-'))
  const outputFile = path.join(outputDir, 'timings.json')
  const reporter = new Reporter({ outputFile })
  reporter.onBegin()
  reporter.onTestEnd(
    {
      title: 'BROWSER-001 登录页加载',
      expectedStatus: 'passed',
      location: { file: 'login.spec.ts', line: 10, column: 1 },
      parent: { project: () => ({ name: 'chromium' }) }
    },
    {
      startTime: new Date('2026-08-17T03:20:00.000Z'),
      duration: 1250,
      retry: 0,
      workerIndex: 1,
      status: 'failed',
      errors: [{ message: 'expected visible', stack: 'at login.spec.ts:10' }],
      attachments: [{ name: 'trace', contentType: 'application/zip', path: 'trace.zip' }]
    }
  )
  await reporter.onEnd({ status: 'failed' })

  const result = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
  assert.equal(result.runner, 'PLAYWRIGHT_TEST')
  assert.equal(result.tests.length, 1)
  assert.deepEqual(result.tests[0], {
    case_id: 'BROWSER-001',
    title: 'BROWSER-001 登录页加载',
    file: 'login.spec.ts',
    line: 10,
    column: 1,
    project: 'chromium',
    retry: 0,
    worker_index: 1,
    status: 'failed',
    expected_status: 'passed',
    started_at: '2026-08-17T03:20:00.000Z',
    finished_at: '2026-08-17T03:20:01.250Z',
    duration_ms: 1250,
    errors: [{ message: 'expected visible', stack: 'at login.spec.ts:10', failure_type: 'ASSERTION' }],
    attachments: [{ name: 'trace', content_type: 'application/zip', path: 'trace.zip' }]
  })
})

test('classifies polling assertions as ASSERTION instead of TIMEOUT', () => {
  const { classifyPlaywrightFailure } = require('../playwright/failure-classifier.cjs')
  const error = new Error("expect(locator).toHaveCount(expected) failed\nExpected: 0\nReceived: 1\nTimeout: 7000ms")
  assert.equal(classifyPlaywrightFailure(error), 'ASSERTION')
  assert.equal(classifyPlaywrightFailure(new Error('Test timeout of 30000ms exceeded.')), 'TIMEOUT')
  assert.equal(classifyPlaywrightFailure(new Error('strict mode violation: locator resolved to 2 elements')), 'LOCATOR')
})

test('resolves exact locator contracts only when exactly one element matches', async () => {
  const { resolveUniqueLocator } = require('../playwright/locator-contract.cjs')
  const calls = []
  const page = {
    getByText: (value, options) => {
      calls.push({ value, options })
      return { count: async () => 2 }
    }
  }
  await assert.rejects(
    resolveUniqueLocator(page, { strategy: 'TEXT', value: '收藏目标', exact: true, unique: true }),
    /resolved to 2 elements/
  )
  assert.deepEqual(calls[0], { value: '收藏目标', options: { exact: true } })
})
