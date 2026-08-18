import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, filePath)
}

export function executionFingerprint(plan, executorFingerprint = '') {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(plan))
    .update('\0')
    .update(String(executorFingerprint))
    .digest('hex')
}

export class CheckpointStore {
  constructor({ runRoot, runId, fingerprint, resume = false }) {
    this.filePath = path.join(path.resolve(runRoot), 'checkpoint.json')
    this.runRoot = path.resolve(runRoot)
    this.runId = runId
    this.fingerprint = fingerprint
    this.resumed = false
    this.previousUpdatedAt = null
    this.state = {
      version: 1,
      run_id: runId,
      fingerprint,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      results: []
    }
    if (resume && fs.existsSync(this.filePath)) {
      const existing = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (existing.run_id !== runId || existing.fingerprint !== fingerprint) {
        throw new Error('Checkpoint does not match the frozen plan and executor; refusing unsafe resume')
      }
      this.previousUpdatedAt = existing.updated_at
      this.state = existing
      this.resumed = true
    }
    this.persist()
  }

  persist() {
    this.state.updated_at = new Date().toISOString()
    writeJson(this.filePath, this.state)
  }

  record(lane, result) {
    const index = this.state.results.findIndex(
      (item) => item.lane === lane && item.result.case_id === result.case_id && item.result.attempt === result.attempt
    )
    const entry = { lane, result }
    if (index >= 0) this.state.results[index] = entry
    else this.state.results.push(entry)
    this.persist()
  }

  reusable(result) {
    if (!result || !Number.isInteger(result.attempt) || !result.timing) return false
    const artifactKeys = new Set(['artifact', 'artifacts', 'state', 'events', 'dom_state', 'screenshot', 'trace', 'runner_screenshot'])
    const paths = []
    const visit = (value, key = null) => {
      if (Array.isArray(value)) return value.forEach((item) => visit(item, key))
      if (value && typeof value === 'object') return Object.entries(value).forEach(([nestedKey, item]) => visit(item, nestedKey))
      if (typeof value === 'string' && artifactKeys.has(key)) paths.push(value)
    }
    visit(result.evidence)
    return paths.every((value) => {
      const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.runRoot, value)
      const relative = path.relative(this.runRoot, candidate)
      return !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(candidate)
    })
  }

  entries(lane) {
    return this.state.results.filter((item) => (!lane || item.lane === lane) && this.reusable(item.result))
  }

  results(lane) {
    return this.entries(lane).map((item) => item.result)
  }

  find(lane, caseId, attempt) {
    const result = this.state.results.find(
      (item) => item.lane === lane && item.result.case_id === caseId && item.result.attempt === attempt
    )?.result
    return this.reusable(result) ? result : undefined
  }
}
