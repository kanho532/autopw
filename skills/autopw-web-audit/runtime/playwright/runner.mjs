import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  PLAYWRIGHT_MODES,
  playwrightCliInvocation,
  resolveBundledPlaywrightRuntime,
  resolveProjectPlaywrightRuntime
} from '../../scripts/playwright/runtime-resolver.mjs'

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(runtimeDirectory, '../../../..')
const bundledConfigPath = path.join(runtimeDirectory, 'playwright.config.mjs')
const bundledModuleLoaderPath = path.join(runtimeDirectory, 'module-loader.mjs')

function assertMode(mode) {
  if (!PLAYWRIGHT_MODES.has(mode)) throw new Error(`Unsupported Playwright mode: ${mode}`)
}

export function resolveRunnerRuntime({ mode = 'AUTOPW_RUNTIME', projectRoot, packageRoot, searchRoots = [] } = {}) {
  assertMode(mode)
  if (mode === 'AUTOPW_RUNTIME') return resolveBundledPlaywrightRuntime({ pluginRoot, packageRoot })
  return resolveProjectPlaywrightRuntime({ projectRoot, packageRoot, searchRoots })
}

export function buildRunnerInvocation({
  mode = 'AUTOPW_RUNTIME',
  projectRoot,
  testDir,
  specPaths = [],
  configPath,
  packageRoot,
  searchRoots = [],
  list = false
} = {}) {
  const runtime = resolveRunnerRuntime({ mode, projectRoot, packageRoot, searchRoots })
  if (!testDir) throw new Error('testDir is required for the bundled Playwright runner')
  if (mode === 'PROJECT_NATIVE' && !configPath) {
    throw new Error('PROJECT_NATIVE requires an explicit project Playwright configPath')
  }
  const selectedConfig = configPath ? path.resolve(configPath) : bundledConfigPath
  const nodeOptions = mode === 'AUTOPW_RUNTIME'
    ? ['--experimental-loader', pathToFileURL(bundledModuleLoaderPath).href]
    : []
  const invocation = playwrightCliInvocation({
    runtime,
    testDir,
    configPath: selectedConfig,
    specPaths,
    list,
    nodeOptions
  })
  return { runtime, config_path: selectedConfig, node_options: nodeOptions, ...invocation }
}

function runProcess(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

export async function runPlaywright({
  mode = 'AUTOPW_RUNTIME',
  projectRoot,
  testDir,
  specPaths = [],
  configPath,
  packageRoot,
  searchRoots = [],
  cwd = projectRoot,
  runRoot,
  outputFile,
  outputDirectory,
  baseURL,
  list = false,
  env = {}
} = {}) {
  const invocation = buildRunnerInvocation({ mode, projectRoot, testDir, specPaths, configPath, packageRoot, searchRoots, list })
  const resolvedRunRoot = runRoot ? path.resolve(runRoot) : null
  const timingOutput = path.resolve(outputFile ?? path.join(resolvedRunRoot ?? process.cwd(), 'playwright', 'autopw-playwright-timings.json'))
  const testOutputDirectory = path.resolve(outputDirectory ?? path.join(resolvedRunRoot ?? process.cwd(), 'playwright', 'test-results'))
  const result = await runProcess(invocation.command, invocation.args, {
    cwd,
    env: {
      AUTOPW_TEST_DIR: path.resolve(testDir),
      AUTOPW_OUTPUT_DIR: testOutputDirectory,
      AUTOPW_TIMING_OUTPUT: timingOutput,
      ...(baseURL ? { AUTOPW_BASE_URL: baseURL } : {}),
      ...env,
      ...(mode === 'AUTOPW_RUNTIME' ? { AUTOPW_BUNDLED_PLAYWRIGHT_PACKAGE_ROOT: invocation.runtime.package_root } : {}),
      ...(mode === 'AUTOPW_RUNTIME' ? { PLAYWRIGHT_BROWSERS_PATH: '0' } : {})
    }
  })
  if (resolvedRunRoot) {
    const outputDirectoryPath = path.join(resolvedRunRoot, 'playwright')
    fs.mkdirSync(outputDirectoryPath, { recursive: true })
    fs.writeFileSync(path.join(outputDirectoryPath, list ? 'runner-list.stdout.txt' : 'runner.stdout.txt'), result.stdout, 'utf8')
    fs.writeFileSync(path.join(outputDirectoryPath, list ? 'runner-list.stderr.txt' : 'runner.stderr.txt'), result.stderr, 'utf8')
  }
  let timings = null
  if (!list && fs.existsSync(timingOutput)) timings = JSON.parse(fs.readFileSync(timingOutput, 'utf8'))
  return { ...invocation, ...result, timing_output: timingOutput, output_directory: testOutputDirectory, timings }
}
