import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { probeCommand, runPreflight } from '../autopw-preflight.mjs'

function write(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

test('probeCommand reports missing tools without throwing', () => {
  const result = probeCommand('autopw-command-that-does-not-exist', ['--version'])
  assert.equal(result.available, false)
  assert.ok(['NOT_FOUND', 'COMMAND_FAILED'].includes(result.error_code))
})
test('preflight discovers package manager, jars, Playwright and Chromium independently', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-preflight-'))
  const playwrightRoot = path.join(root, 'configured-runtime', 'node_modules', 'playwright')
  const browserRoot = path.join(root, 'browsers')
  const output = path.join(root, 'audit', 'preflight.json')
  write(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { dev: 'vite --port 43123' } }))
  write(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
  write(path.join(root, 'target', 'app.jar'), 'jar')
  write(path.join(root, '.env.example'), 'API_PORT=43124\n')
  write(path.join(playwrightRoot, 'package.json'), JSON.stringify({ name: 'playwright', version: '9.9.9' }))
  write(path.join(playwrightRoot, 'cli.js'))
  write(path.join(playwrightRoot, 'test.js'))
  const executable = path.join(browserRoot, 'chromium-123', process.platform === 'win32' ? 'chrome-win' : 'chrome-linux', process.platform === 'win32' ? 'chrome.exe' : 'chrome')
  write(executable, 'browser')

  const result = await runPreflight({
    root,
    output,
    configuredPlaywrightRoots: [path.join(root, 'configured-runtime')],
    browserRoots: [browserRoot],
  })

  assert.equal(result.root, path.resolve(root))
  assert.equal(result.artifacts.fat_jars[0], 'target/app.jar')
  assert.equal(result.package_manager.name, 'pnpm')
  assert.equal(result.playwright.available, true)
  assert.equal(result.playwright.version, '1.62.1')
  assert.equal(result.playwright.browser.chromium.available, true)
  assert.equal(result.recommendation.backend_start, 'EXISTING_JAR')
  assert.equal(result.recommendation.browser_executor, 'PLAYWRIGHT_TEST')
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), result)
  assert.ok(result.target_ports.ports.some((item) => item.port === 43123))
  assert.ok(result.target_ports.ports.some((item) => item.port === 43124))

  const native = await runPreflight({
    root,
    playwrightMode: 'PROJECT_NATIVE',
    configuredPlaywrightRoots: [path.join(root, 'configured-runtime')],
    browserRoots: [browserRoot],
    useMemory: false,
  })
  assert.equal(native.playwright.version, '9.9.9')
})

test('preflight keeps going when Maven and Playwright are unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-preflight-missing-'))
  write(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }))
  const result = await runPreflight({
    root,
    playwrightMode: 'PROJECT_NATIVE',
    env: {
      ...process.env,
      PATH: '',
      AUTOPW_PLAYWRIGHT_PACKAGE_ROOT: path.join(root, 'missing-playwright'),
    },
  })

  assert.equal(result.maven.available, false)
  assert.equal(result.playwright.available, false)
  assert.equal(result.recommendation.browser_executor, 'UNAVAILABLE')
  assert.equal(typeof result.node.available, 'boolean')
  assert.equal(typeof result.npm.available, 'boolean')
})
