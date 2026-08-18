import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

function now() {
  return new Date().toISOString()
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function commandExtension(command) {
  return path.extname(String(command)).toLowerCase()
}

export function portableSpawnSpec(command, args = [], platform = process.platform) {
  if (platform === 'win32' && ['.cmd', '.bat'].includes(commandExtension(command))) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
      wrapped: true
    }
  }
  return { command, args, wrapped: false }
}

export function spawnPortable(command, args = [], options = {}) {
  const { platform = process.platform, ...spawnOptions } = options
  const spec = portableSpawnSpec(command, args, platform)
  return spawn(spec.command, spec.args, {
    windowsHide: true,
    shell: false,
    ...spawnOptions
  })
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function terminateWindowsTree(pid) {
  return spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false
  })
}

function terminatePosixTree(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

export class ProcessRegistry {
  constructor({ runRoot, platform = process.platform } = {}) {
    this.runRoot = runRoot ? path.resolve(runRoot) : null
    this.platform = platform
    this.records = []
    this.children = new Map()
    this.ledgerPath = this.runRoot ? path.join(this.runRoot, 'runtime', 'processes.json') : null
  }

  persist() {
    if (!this.ledgerPath) return
    writeJson(this.ledgerPath, {
      updated_at: now(),
      processes: this.records
    })
  }

  spawn(command, args = [], options = {}) {
    const detached = options.detached ?? this.platform !== 'win32'
    const child = spawnPortable(command, args, { ...options, platform: this.platform, detached })
    const record = {
      pid: child.pid,
      command: String(command),
      args: args.map(String),
      started_at: now(),
      finished_at: null,
      exit_code: null,
      signal: null,
      cleaned: false
    }
    this.records.push(record)
    if (Number.isInteger(child.pid)) this.children.set(child.pid, child)
    child.once('exit', (code, signal) => {
      record.finished_at = now()
      record.exit_code = code
      record.signal = signal
      this.persist()
    })
    child.once('error', (error) => {
      record.finished_at = now()
      record.error = error.message
      this.persist()
    })
    this.persist()
    return child
  }

  recoverOwnedProcesses() {
    if (!this.ledgerPath || !fs.existsSync(this.ledgerPath)) return []
    const ledger = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8'))
    const recovered = []
    for (const record of ledger.processes ?? []) {
      if (!Number.isInteger(record.pid) || record.cleaned) continue
      if (this.platform === 'win32') {
        const result = terminateWindowsTree(record.pid)
        recovered.push({ pid: record.pid, status: result.status, recovered: result.status === 0 })
      } else {
        try {
          terminatePosixTree(record.pid, 'SIGKILL')
          recovered.push({ pid: record.pid, status: 0, recovered: true })
        } catch (error) {
          recovered.push({ pid: record.pid, status: null, recovered: false, error: error.message })
        }
      }
    }
    return recovered
  }

  async cleanup({ graceMs = 2000 } = {}) {
    const summary = []
    for (const record of [...this.records].reverse()) {
      const child = this.children.get(record.pid)
      if (!Number.isInteger(record.pid) || record.cleaned || (child && child.exitCode !== null)) {
        record.cleaned = true
        continue
      }
      try {
        if (this.platform === 'win32') {
          const result = terminateWindowsTree(record.pid)
          summary.push({ pid: record.pid, command: record.command, status: result.status })
        } else {
          terminatePosixTree(record.pid, 'SIGTERM')
          if (child && !(await waitForExit(child, graceMs))) terminatePosixTree(record.pid, 'SIGKILL')
          summary.push({ pid: record.pid, command: record.command, status: 0 })
        }
        record.cleaned = true
      } catch (error) {
        summary.push({ pid: record.pid, command: record.command, status: null, error: error.message })
      }
    }
    this.persist()
    return summary
  }
}

export function createRunIsolation(plan, runRoot) {
  const safeId = String(plan.run_id).replace(/[^a-zA-Z0-9_-]+/g, '_')
  const dataPrefix = `autopw_${safeId}_`
  return {
    run_id: plan.run_id,
    data_prefix: dataPrefix,
    root: path.join(path.resolve(runRoot), 'runtime'),
    env: {
      AUTOPW_RUN_ID: plan.run_id,
      AUTOPW_DATA_PREFIX: dataPrefix,
      AUTOPW_RUN_ROOT: path.resolve(runRoot)
    }
  }
}

export async function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

export async function assertManagedPortsAvailable(services = []) {
  for (const service of services) {
    if (service?.managed_by !== 'AUTOPW' || !Number.isInteger(service.port)) continue
    if (!(await isPortAvailable(service.port, service.host || '127.0.0.1'))) {
      throw new Error(`Managed service port ${service.port} is already occupied; refusing to reuse an unowned process`)
    }
  }
}
