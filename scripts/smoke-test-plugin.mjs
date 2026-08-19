#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(process.argv[2] ?? process.cwd())
const runnerPath = path.join(pluginRoot, 'skills', 'autopw-web-audit', 'runtime', 'playwright', 'runner.mjs')
const packageRoot = path.join(pluginRoot, 'node_modules', '@playwright', 'test')
const browserRoot = path.join(pluginRoot, 'node_modules', 'playwright-core', '.local-browsers')
assert.ok(fs.existsSync(packageRoot), `Missing bundled Playwright package: ${packageRoot}`)
assert.ok(fs.existsSync(browserRoot), `Missing bundled browser directory: ${browserRoot}`)
const chromiumDirectory = fs.readdirSync(browserRoot, { withFileTypes: true })
  .find((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
assert.ok(chromiumDirectory, `Missing bundled Chromium version directory under ${browserRoot}`)
assert.ok(
  fs.existsSync(path.join(browserRoot, chromiumDirectory.name, 'chrome-win64', 'chrome.exe')),
  'Missing bundled Chromium executable'
)

const { runPlaywright } = await import(pathToFileURL(runnerPath).href)
const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-fake-target-'))
const testDir = path.join(targetRoot, 'autopw-output', 'generated')
const runRoot = path.join(targetRoot, 'run')
const specPath = path.join(testDir, 'BROWSER-001.spec.mjs')
fs.mkdirSync(testDir, { recursive: true })
fs.writeFileSync(specPath, `import { test, expect } from '@playwright/test'\n\ntest('BROWSER-001 bundled smoke', async ({ page }) => {\n  await page.setContent('<button data-testid="ok">OK</button>')\n  await expect(page.getByTestId('ok')).toBeVisible()\n})\n`, 'utf8')

const options = {
  mode: 'AUTOPW_RUNTIME',
  projectRoot: targetRoot,
  testDir,
  specPaths: [specPath],
  runRoot
}
const listed = await runPlaywright({ ...options, list: true })
assert.equal(listed.code, 0, listed.stderr || listed.stdout)
const executed = await runPlaywright(options)
assert.equal(executed.code, 0, executed.stderr || executed.stdout)
assert.equal(executed.timings?.tests?.[0]?.case_id, 'BROWSER-001')
assert.equal(executed.timings?.tests?.[0]?.status, 'passed')
console.log(`Bundled plugin smoke PASS: ${pluginRoot}`)
