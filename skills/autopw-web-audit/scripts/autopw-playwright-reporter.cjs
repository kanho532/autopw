const fs = require('node:fs')
const path = require('node:path')
const { classifyPlaywrightFailure } = require('./playwright/failure-classifier.cjs')

function iso(value) {
  return new Date(value).toISOString()
}

function extractCaseId(title) {
  const match = String(title).match(/\b(?:API|BROWSER|STATIC|LOG_STATE|DISCOVERED)-\d+\b/)
  return match ? match[0] : null
}

class AutoPWPlaywrightReporter {
  constructor(options = {}) {
    this.outputFile = path.resolve(
      options.outputFile || process.env.AUTOPW_TIMING_OUTPUT || 'autopw-playwright-timings.json'
    )
    this.startedAt = null
    this.tests = []
  }

  onBegin() {
    this.startedAt = new Date()
  }

  onTestEnd(test, result) {
    const started = result.startTime instanceof Date ? result.startTime : new Date(result.startTime)
    const duration = Number.isFinite(result.duration) ? result.duration : 0
    const finished = new Date(started.getTime() + duration)
    this.tests.push({
      case_id: extractCaseId(test.title),
      title: test.title,
      file: test.location?.file ?? null,
      line: test.location?.line ?? null,
      column: test.location?.column ?? null,
      project: test.parent?.project()?.name ?? null,
      retry: result.retry ?? 0,
      worker_index: result.workerIndex ?? null,
      status: result.status,
      expected_status: test.expectedStatus,
      started_at: iso(started),
      finished_at: iso(finished),
      duration_ms: duration,
      errors: (result.errors ?? []).map((error) => ({
        message: error.message ?? null,
        stack: error.stack ?? null,
        failure_type: classifyPlaywrightFailure(error)
      })),
      attachments: (result.attachments ?? []).map((attachment) => ({
        name: attachment.name,
        content_type: attachment.contentType,
        path: attachment.path ?? null
      }))
    })
  }

  async onEnd(result) {
    const finishedAt = new Date()
    const startedAt = this.startedAt ?? finishedAt
    const payload = {
      runner: 'PLAYWRIGHT_TEST',
      status: result.status,
      started_at: iso(startedAt),
      finished_at: iso(finishedAt),
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      tests: this.tests
    }
    fs.mkdirSync(path.dirname(this.outputFile), { recursive: true })
    fs.writeFileSync(this.outputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }

  printsToStdio() {
    return false
  }
}

module.exports = AutoPWPlaywrightReporter
module.exports.extractCaseId = extractCaseId
