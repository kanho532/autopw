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
    errors: [{ message: 'expected visible', stack: 'at login.spec.ts:10' }],
    attachments: [{ name: 'trace', content_type: 'application/zip', path: 'trace.zip' }]
  })
})
