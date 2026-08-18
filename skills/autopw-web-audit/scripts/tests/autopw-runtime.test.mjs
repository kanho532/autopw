import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { EvidenceImporter } from '../evidence/import.mjs'
import { orchestrateRun } from '../orchestration/run.mjs'
import { ProcessRegistry } from '../runtime/process-registry.mjs'
import {
  inspectPlaywrightRuntime,
  playwrightCliInvocation,
  relativePlaywrightSpec,
  resolvePlaywrightRuntime
} from '../playwright/runtime-resolver.mjs'
import { validateSchema } from '../lib/schema-validator.mjs'
import { validateRun } from '../autopw-validate.mjs'

function apiCase(id, dependencies = []) {
  return {
    id,
    channel: 'API',
    executor: 'DIRECT_API',
    source: {},
    preconditions: [],
    steps: ['请求接口'],
    assertions: ['响应正确'],
    evidence_contract: ['artifact'],
    dependencies,
    resource_locks: [],
    mutates: false,
    cleanup: [],
    mcp_trigger: 'NONE'
  }
}

function plan(root, cases = [apiCase('API-001')]) {
  return {
    run_id: 'runtime-test',
    scope_mode: 'FULL',
    frozen_at: '2020-01-01T00:00:00.000Z',
    target: { repository: root, head: 'HEAD', worktree_status: [] },
    environment: { timezone: 'UTC', locale: 'zh-CN', services: [], playwright: {} },
    cases
  }
}

function timing() {
  const started = new Date()
  const finished = new Date(started.getTime() + 1)
  return { started_at: started.toISOString(), finished_at: finished.toISOString(), duration_ms: 1 }
}

test('process registry executes the command selected by the executor without rewriting it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-process-'))
  const registry = new ProcessRegistry({ runRoot: root })
  const child = registry.spawn(process.execPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  assert.equal(code, 0)
  assert.match(stdout.trim(), /^v\d+\./)
  assert.equal(registry.records[0].command, process.execPath)
})

test('resolves one Playwright package for both CLI and test imports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-playwright-runtime-'))
  const packageRoot = path.join(root, 'node_modules', 'playwright')
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.2.3' }))
  fs.writeFileSync(path.join(packageRoot, 'cli.js'), '')
  fs.writeFileSync(path.join(packageRoot, 'test.js'), '')

  const runtime = resolvePlaywrightRuntime({ projectRoot: root })
  assert.deepEqual(runtime, inspectPlaywrightRuntime(packageRoot))
  assert.equal(runtime.version, '1.2.3')
  assert.equal(runtime.cli_path, path.join(packageRoot, 'cli.js'))
  assert.equal(runtime.test_module_path, path.join(packageRoot, 'test.js'))
})

test('builds Playwright CLI filters relative to testDir and rejects external specs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-playwright-spec-'))
  const testDir = path.join(root, 'generated')
  const specPath = path.join(testDir, 'browser-001.spec.cjs')
  const runtime = { cli_path: path.join(root, 'playwright', 'cli.js'), test_module_path: path.join(root, 'playwright', 'test.js') }
  const configPath = path.join(root, 'playwright.config.cjs')

  assert.equal(relativePlaywrightSpec(testDir, specPath), 'browser-001.spec.cjs')
  const invocation = playwrightCliInvocation({ runtime, testDir, configPath, specPaths: [specPath], list: true })
  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.args, [runtime.cli_path, 'test', 'browser-001.spec.cjs', '--config', path.resolve(configPath), '--list'])
  assert.throws(() => relativePlaywrightSpec(testDir, path.join(root, 'outside.spec.cjs')), /below testDir/)
})

test('imports MCP evidence into the run root with a checksum manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-evidence-'))
  const staging = path.join(root, 'staging')
  const runRoot = path.join(root, 'run')
  fs.mkdirSync(staging)
  const source = path.join(staging, 'snapshot.yml')
  fs.writeFileSync(source, 'snapshot')
  const importer = new EvidenceImporter({ runRoot, sourceRoots: [staging] })
  const imported = importer.import(source, 'mcp/BROWSER-001/snapshot.yml')
  assert.equal(imported, 'mcp/BROWSER-001/snapshot.yml')
  assert.equal(fs.readFileSync(path.join(runRoot, imported), 'utf8'), 'snapshot')
  const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'mcp', 'evidence-manifest.json'), 'utf8'))
  assert.equal(manifest.artifacts[0].sha256.length, 64)
})

test('resumes from a matching checkpoint without rerunning successful cases from a failed batch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-resume-'))
  const runRoot = path.join(root, 'run')
  const frozen = plan(root, [apiCase('API-001'), apiCase('API-002')])
  const calls = { 'API-001': 0, 'API-002': 0 }
  const executors = {
    DIRECT_API: async (testCase, context) => {
      calls[testCase.id] += 1
      if (testCase.id === 'API-002' && calls[testCase.id] === 1) throw new Error('synthetic interruption')
      const artifact = `api/${testCase.id}.json`
      fs.mkdirSync(path.join(runRoot, 'api'), { recursive: true })
      fs.writeFileSync(path.join(runRoot, artifact), '{}')
      return { case_id: testCase.id, attempt: context.attempt, status: 'PASS', timing: timing(), evidence: { artifact } }
    }
  }
  await assert.rejects(orchestrateRun({ plan: frozen, runRoot, executors }), /synthetic interruption/)
  const summary = await orchestrateRun({ plan: frozen, runRoot, executors, resume: true })
  assert.equal(summary.resumed, true)
  assert.deepEqual(calls, { 'API-001': 1, 'API-002': 2 })
  const session = JSON.parse(fs.readFileSync(path.join(runRoot, 'audit-session.json'), 'utf8'))
  assert.equal(session.invocations.length, 2)
  assert.equal(session.invocations[0].status, 'FAIL')
  assert.equal(session.invocations[1].status, 'PASS')
  assert.equal(validateSchema('audit-session', session).valid, true)
})

test('always cleans the registered service process tree after executor failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-cleanup-'))
  const runRoot = path.join(root, 'run')
  let child
  const lifecycle = {
    setup: async ({ runtime }) => {
      child = runtime.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    }
  }
  const executors = { DIRECT_API: async () => { throw new Error('executor failed') } }
  await assert.rejects(orchestrateRun({ plan: plan(root), runRoot, executors, lifecycle }), /executor failed/)
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  const ledger = JSON.parse(fs.readFileSync(path.join(runRoot, 'runtime', 'processes.json'), 'utf8'))
  assert.equal(ledger.processes[0].cleaned, true)
})

test('generated session, lane and report pass end-to-end validation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-e2e-'))
  const runRoot = path.join(root, 'run')
  const frozen = plan(root)
  const executors = {
    DIRECT_API: async (testCase, context) => {
      const artifact = `api/${testCase.id}.json`
      fs.mkdirSync(path.join(runRoot, 'api'), { recursive: true })
      fs.writeFileSync(path.join(runRoot, artifact), '{}')
      return { case_id: testCase.id, attempt: context.attempt, status: 'PASS', timing: timing(), evidence: { artifact } }
    }
  }
  const summary = await orchestrateRun({ plan: frozen, runRoot, executors })
  const planPath = path.join(root, 'execution-plan.json')
  const reportPath = path.join(root, 'report.md')
  fs.writeFileSync(planPath, `${JSON.stringify(frozen, null, 2)}\n`)
  fs.writeFileSync(reportPath, `# Report\n\nAPI-001\n\n审查会话总耗时: ${summary.duration_ms} ms\n\n| 用例状态 | 数量 |\n|---|---:|\n| 通过 | 1 |\n| 失败/发现问题 | 0 |\n| 阻塞 | 0 |\n| 未执行/超出范围 | 0 |\n| 不稳定 | 0 |\n\n[plan](execution-plan.json)\n`)
  const validation = validateRun({ planPath, runRoot, reportPath })
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
})

test('schema models commit-to-commit scope and rejects ambiguous browser locators', () => {
  const root = 'D:/repo'
  const commitPlan = plan(root)
  commitPlan.scope_mode = 'COMMIT_TO_COMMIT'
  commitPlan.target = {
    repository: root,
    baseline: '1'.repeat(40),
    head: '2'.repeat(40),
    worktree_status: []
  }
  assert.equal(validateSchema('execution-plan', commitPlan).valid, true)
  commitPlan.target.worktree_status = ['M local.txt']
  assert.equal(validateSchema('execution-plan', commitPlan).valid, false)

  const browser = plan(root, [{
    ...apiCase('BROWSER-001'),
    channel: 'BROWSER',
    executor: 'PLAYWRIGHT_TEST',
    locator_contract: [{ strategy: 'TEXT', value: '收藏目标', exact: false, unique: true }]
  }])
  assert.equal(validateSchema('execution-plan', browser).valid, false)
  browser.cases[0].locator_contract[0].exact = true
  assert.equal(validateSchema('execution-plan', browser).valid, true)
})
