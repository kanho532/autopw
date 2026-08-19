import fs from 'node:fs'
import path from 'node:path'

import { runPlaywright } from '../../runtime/playwright/runner.mjs'

const FAILURE_TYPES = new Set(['ASSERTION', 'LOCATOR', 'REQUEST_FAILED', 'PAGE_ERROR', 'NAVIGATION', 'TIMEOUT', 'INFRASTRUCTURE'])

function now() {
  return new Date().toISOString()
}

function timing(startedAt, finishedAt = now()) {
  const started = Date.parse(startedAt)
  const finished = Date.parse(finishedAt)
  return {
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, (Number.isFinite(finished) ? finished : Date.now()) - (Number.isFinite(started) ? started : Date.now()))
  }
}

function sourceValue(testCase, keys) {
  for (const key of keys) {
    if (testCase.source?.[key]) return testCase.source[key]
  }
  return null
}

function resolveSpecPath(testCase, { runRoot, projectRoot }) {
  const value = sourceValue(testCase, ['spec_path', 'spec', 'generated_spec_path'])
  if (!value) return null
  if (path.isAbsolute(value)) return path.resolve(value)
  const candidates = [path.resolve(runRoot, value)]
  if (projectRoot) candidates.push(path.resolve(projectRoot, value))
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

function resultStatus(test) {
  if (test?.status === 'passed') return 'PASS'
  if (test?.status === 'skipped' || test?.status === 'interrupted') return 'NOT_RUN'
  return 'FAIL'
}

function failureType(test) {
  const candidate = test?.errors?.find((error) => FAILURE_TYPES.has(error.failure_type))?.failure_type
  return candidate ?? 'INFRASTRUCTURE'
}

function executionContext(testCase, context, runtime, specPath, title) {
  const environment = context.plan?.environment ?? {}
  return {
    runner: 'PLAYWRIGHT_TEST',
    runner_version: runtime?.version ?? 'unknown',
    browser: 'chromium',
    browser_build: context.runtime?.playwright?.browser_build ?? 'managed-by-host',
    viewport: sourceValue(testCase, ['viewport']) ?? { width: 1280, height: 720 },
    locale: sourceValue(testCase, ['locale']) ?? environment.locale ?? 'en-US',
    timezone: sourceValue(testCase, ['timezone']) ?? environment.timezone ?? 'UTC',
    spec_path: path.relative(context.run_root, specPath).split(path.sep).join('/') || path.basename(specPath),
    test_title: title || testCase.title || testCase.id,
    storage_state_contract: sourceValue(testCase, ['storage_state_contract', 'storage_state']) ?? 'No persistent storage state; isolated browser context per case',
    steps: testCase.steps?.map(String) ?? ['Execute frozen browser specification'],
    assertions: testCase.assertions?.map(String) ?? ['Frozen browser assertions pass'],
    locator_contract: testCase.locator_contract ?? [{ strategy: 'CSS', value: 'body', exact: true, unique: true }]
  }
}

function mapTestResult(testCase, test, context, runtime, specPath) {
  const startedAt = test?.started_at ?? now()
  const status = resultStatus(test)
  const result = {
    case_id: testCase.id,
    attempt: context.attempt,
    status,
    timing: test ? timing(startedAt, test.finished_at) : timing(startedAt),
    execution_context: executionContext(testCase, context, runtime, specPath, test?.title),
    isolation_id: context.runtime?.isolation?.data_prefix ?? `${context.run_id}:${context.attempt}`
  }
  if (status === 'NOT_RUN') {
    result.not_run = { code: 'UNSUPPORTED_ENVIRONMENT', detail: `Playwright reported status ${test?.status ?? 'not found'}` }
  }
  if (status === 'FAIL') {
    const error = test?.errors?.[0] ?? { message: `Playwright reported status ${test?.status ?? 'failed'}`, stack: null }
    result.failure_type = failureType(test)
    result.failure_signature = {
      case_id: testCase.id,
      failure_type: result.failure_type,
      route: null,
      assertion: error.message ?? null,
      locator: null,
      http_method: null,
      http_status: null,
      top_stack_frame: error.stack?.split('\n')[0] ?? null
    }
    result.evidence = {
      errors: test?.errors ?? [],
      attachments: test?.attachments ?? []
    }
  }
  return result
}

function blockedResult(testCase, context, detail, runtime = null, specPath = path.join(context.run_root, 'playwright', 'missing.spec.mjs')) {
  const startedAt = now()
  return {
    case_id: testCase.id,
    attempt: context.attempt,
    status: 'BLOCKED',
    timing: timing(startedAt, startedAt),
    blocked: { code: 'EXECUTOR_UNAVAILABLE', detail },
    execution_context: executionContext(testCase, context, runtime ?? { version: 'unavailable' }, specPath, testCase.title || testCase.id),
    isolation_id: context.runtime?.isolation?.data_prefix ?? `${context.run_id}:${context.attempt}`
  }
}

function attemptEnvironment(context, runRoot) {
  const isolation = context.runtime?.isolation ?? {}
  const stateDirectory = path.join(path.resolve(runRoot), 'playwright', 'state', `attempt-${context.attempt}`)
  fs.mkdirSync(stateDirectory, { recursive: true })
  return {
    ...(isolation.env ?? {}),
    AUTOPW_ATTEMPT: String(context.attempt),
    AUTOPW_DATA_PREFIX: isolation.data_prefix ?? `${context.run_id}:attempt:${context.attempt}`,
    AUTOPW_BROWSER_STATE_DIR: stateDirectory
  }
}

export function createPlaywrightExecutor({
  plan,
  runRoot,
  projectRoot = plan?.target?.repository,
  mode = plan?.environment?.playwright?.mode ?? 'AUTOPW_RUNTIME',
  runner = runPlaywright,
  packageRoot,
  searchRoots = []
} = {}) {
  const batches = new Map()
  return async function playrightExecutor(testCase, context) {
    const batchCases = context.batch_cases?.length ? context.batch_cases : [testCase]
    const batchKey = batchCases.map((item) => item.id).sort().join(',')
    const key = `${context.attempt}:${batchKey}`
    if (!batches.has(key)) {
      batches.set(key, runBatch({ plan, runRoot, projectRoot, mode, runner, packageRoot, searchRoots, batchCases, context }))
    }
    const batch = await batches.get(key)
    return batch.get(testCase.id) ?? blockedResult(testCase, context, 'Playwright batch did not produce a result for this case.')
  }
}

async function runBatch({ plan, runRoot, projectRoot, mode, runner, packageRoot, searchRoots, batchCases, context }) {
  const cases = batchCases.filter((item) => item.executor === 'PLAYWRIGHT_TEST')
  const specs = cases.map((item) => ({ testCase: item, specPath: resolveSpecPath(item, { runRoot, projectRoot }) }))
  const missing = specs.filter((item) => !item.specPath)
  const results = new Map(missing.map(({ testCase }) => [testCase.id, blockedResult(testCase, context, 'Browser case has no generated or declared Playwright spec path.')]))
  const runnable = specs.filter((item) => item.specPath)
  if (runnable.length === 0) return results

  const testDir = sourceValue(runnable[0].testCase, ['test_dir'])
    ? path.resolve(runRoot, sourceValue(runnable[0].testCase, ['test_dir']))
    : path.dirname(runnable[0].specPath)
  const specPaths = [...new Set(runnable.map(({ specPath }) => specPath))]
  const outputFile = path.join(runRoot, 'playwright', `autopw-playwright-timings-attempt-${context.attempt}.json`)
  let runtime = null
  try {
    const env = attemptEnvironment(context, runRoot)
    const listed = await runner({ mode, projectRoot, testDir, specPaths, packageRoot, searchRoots, configPath: sourceValue(runnable[0].testCase, ['config_path']), runRoot, outputFile, baseURL: plan?.environment?.playwright?.base_url, env, list: true })
    if (listed.code !== 0) throw new Error(`Playwright --list failed with exit code ${listed.code}: ${listed.stderr || listed.stdout}`)
    const executed = await runner({ mode, projectRoot, testDir, specPaths, packageRoot, searchRoots, configPath: sourceValue(runnable[0].testCase, ['config_path']), runRoot, outputFile, baseURL: plan?.environment?.playwright?.base_url, env })
    runtime = executed.runtime
    if (executed.code !== 0 && !executed.timings) throw new Error(`Playwright execution failed with exit code ${executed.code}: ${executed.stderr || executed.stdout}`)
    const byCase = new Map((executed.timings?.tests ?? []).filter((item) => item.case_id).map((item) => [item.case_id, item]))
    for (const { testCase, specPath } of runnable) {
      const test = byCase.get(testCase.id)
      results.set(testCase.id, test ? mapTestResult(testCase, test, context, runtime, specPath) : blockedResult(testCase, context, 'Playwright completed without reporter evidence for this case.', runtime, specPath))
    }
  } catch (error) {
    for (const { testCase, specPath } of runnable) results.set(testCase.id, blockedResult(testCase, context, error.message, runtime, specPath))
  }
  return results
}
