import fs from 'node:fs'
import path from 'node:path'

function now() {
  return new Date().toISOString()
}

function duration(startedAt, finishedAt) {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
}

export class AuditSession {
  constructor({ runRoot, runId, resumed = false, previousUpdatedAt = null }) {
    this.filePath = path.join(path.resolve(runRoot), 'audit-session.json')
    this.document = resumed && fs.existsSync(this.filePath)
      ? JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      : {
          version: 1,
          run_id: runId,
          started_at: now(),
          finished_at: null,
          duration_ms: 0,
          invocations: [],
          phases: [],
          totals: {}
        }
    this.invocation = { started_at: now(), finished_at: null, duration_ms: 0, status: 'RUNNING', resumed }
    if (resumed && previousUpdatedAt) {
      this.invocation.external_wait_or_intervention_ms = Math.max(0, Date.now() - Date.parse(previousUpdatedAt))
    }
    this.document.invocations.push(this.invocation)
    this.persist()
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.document, null, 2)}\n`, 'utf8')
  }

  async phase(name, action) {
    const phase = { name, started_at: now(), finished_at: null, duration_ms: 0, status: 'RUNNING' }
    this.document.phases.push(phase)
    this.persist()
    try {
      const value = await action()
      phase.status = 'PASS'
      return value
    } catch (error) {
      phase.status = 'FAIL'
      phase.error = error.message
      throw error
    } finally {
      phase.finished_at = now()
      phase.duration_ms = duration(phase.started_at, phase.finished_at)
      this.persist()
    }
  }

  finish(status, details = {}) {
    this.invocation.finished_at = now()
    this.invocation.duration_ms = duration(this.invocation.started_at, this.invocation.finished_at)
    this.invocation.status = status
    Object.assign(this.invocation, details)
    this.document.finished_at = this.invocation.finished_at
    this.document.duration_ms = duration(this.document.started_at, this.document.finished_at)
    const totals = {}
    for (const phase of this.document.phases) totals[phase.name] = (totals[phase.name] ?? 0) + phase.duration_ms
    totals.external_wait_or_intervention_ms = this.document.invocations.reduce(
      (sum, item) => sum + (item.external_wait_or_intervention_ms ?? 0),
      0
    )
    this.document.totals = totals
    this.persist()
    return this.document
  }
}
