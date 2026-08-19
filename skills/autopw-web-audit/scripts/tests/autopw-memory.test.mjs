import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { validateSchema } from '../lib/schema-validator.mjs'
import { computeProjectFingerprint } from '../memory/fingerprint.mjs'
import { loadProjectMemory, readProjectMemory } from '../memory/load.mjs'
import { updateProjectMemory } from '../memory/update.mjs'
import { runPreflight } from '../autopw-preflight.mjs'

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

test('fingerprint only changes for runtime configuration files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-fingerprint-'))
  write(path.join(root, 'package.json'), '{"scripts":{"dev":"node server.js"}}')
  const first = computeProjectFingerprint(root)
  write(path.join(root, 'README.md'), 'unrelated')
  assert.deepEqual(computeProjectFingerprint(root), first)
  write(path.join(root, 'package.json'), '{"scripts":{"dev":"node changed.js"}}')
  assert.notEqual(computeProjectFingerprint(root).project_fingerprint, first.project_fingerprint)
})

test('updateProjectMemory persists only explicitly verified runtime facts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-memory-'))
  const result = updateProjectMemory({
    root,
    runtime: {
      backend: { strategy: 'EXISTING_JAR', command: ['java', '-jar', 'target/app.jar'], cwd: '.', port: 8080 },
      frontend: { strategy: 'PACKAGE_MANAGER', command: ['npm', 'run', 'dev'], cwd: '.', port: 5173 },
    },
    environment: { node_version: 'guessed', java_version: '17' },
    verified: { backend_start: false, frontend_start: true, playwright: false },
    environmentVerified: { java_version: false },
  })

  const memory = loadProjectMemory(root)
  assert.equal(result.path, path.join(root, '.autopw', 'project-memory.json'))
  assert.equal(memory.runtime.backend, undefined)
  assert.equal(memory.runtime.frontend.source, 'VERIFIED_RUNTIME')
  assert.deepEqual(memory.environment, {})
  assert.equal(validateSchema('project-memory', memory).valid, true)
  assert.equal(readProjectMemory(root).status, 'AVAILABLE')
})

test('preflight reuses valid project memory and falls back after fingerprint change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopw-memory-reuse-'))
  write(path.join(root, 'package.json'), '{"scripts":{"dev":"node server.js"}}')
  updateProjectMemory({
    root,
    runtime: { backend: { strategy: 'NODE', command: [process.execPath, '--version'], cwd: '.' } },
    environment: { node_version: process.version, package_manager: 'npm' },
    verified: { backend_start: true, frontend_start: false, playwright: false, environment: true },
    preflightSnapshot: { marker: 'cached-snapshot' },
  })

  const reused = await runPreflight({ root })
  assert.equal(reused.memory.status, 'REUSED')
  assert.equal(reused.marker, 'cached-snapshot')

  write(path.join(root, 'package.json'), '{"scripts":{"dev":"node changed-server.js"}}')
  const refreshed = await runPreflight({ root, useMemory: true })
  assert.equal(refreshed.memory.status, 'STALE')
  assert.equal(refreshed.marker, undefined)
})
