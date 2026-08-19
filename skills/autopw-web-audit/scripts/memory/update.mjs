import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { computeProjectFingerprint } from './fingerprint.mjs'
import { projectMemoryPath } from './load.mjs'
import { assertSchema } from '../lib/schema-validator.mjs'

const ENVIRONMENT_KEYS = new Set([
  'node_version',
  'npm_version',
  'java_version',
  'maven_version',
  'package_manager',
  'playwright_version',
  'playwright_package_root',
  'chromium_executable',
])

function verifiedRuntimeTarget(target) {
  if (!target) return null
  return { ...target, source: 'VERIFIED_RUNTIME' }
}

function selectEnvironment(environment, verified, environmentVerified) {
  const selected = {}
  const allVerified = verified.environment === true
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (value === undefined || value === null || !ENVIRONMENT_KEYS.has(key)) continue
    if (allVerified || environmentVerified[key] === true || (verified.playwright === true && ['playwright_version', 'playwright_package_root', 'chromium_executable'].includes(key))) {
      selected[key] = String(value)
    }
  }
  return selected
}

export function updateProjectMemory({
  root,
  runtime = {},
  environment = {},
  verified = {},
  environmentVerified = {},
  executorHints,
  preflightSnapshot,
  updatedAt = new Date().toISOString(),
} = {}) {
  if (!root) throw new Error('root is required')
  const resolvedRoot = path.resolve(root)
  const fingerprint = computeProjectFingerprint(resolvedRoot)
  const verifiedState = {
    backend_start: verified.backend_start === true,
    frontend_start: verified.frontend_start === true,
    playwright: verified.playwright === true,
    ...(verified.environment !== undefined ? { environment: verified.environment === true } : {}),
  }
  const storedRuntime = {}
  if (verifiedState.backend_start && runtime.backend) storedRuntime.backend = verifiedRuntimeTarget(runtime.backend)
  if (verifiedState.frontend_start && runtime.frontend) storedRuntime.frontend = verifiedRuntimeTarget(runtime.frontend)

  if (!verifiedState.backend_start && !verifiedState.frontend_start && !verifiedState.playwright && verifiedState.environment !== true) {
    throw new Error('At least one verified fact is required')
  }

  const memory = {
    version: 1,
    project_fingerprint: fingerprint.project_fingerprint,
    fingerprint_files: fingerprint.fingerprint_files,
    updated_at: updatedAt,
    runtime: storedRuntime,
    environment: selectEnvironment(environment, verifiedState, environmentVerified),
    verified: verifiedState,
    ...(executorHints ? { executor_hints: executorHints } : {}),
    ...(preflightSnapshot ? { preflight_snapshot: preflightSnapshot } : {}),
  }
  assertSchema('project-memory', memory)

  const filePath = projectMemoryPath(resolvedRoot)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(memory, null, 2)}\n`, 'utf8')
  fs.renameSync(temporaryPath, filePath)
  return { path: filePath, memory }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--root') { options.root = next; index += 1; continue }
    if (arg === '--input') { options.input = next; index += 1; continue }
    if (arg === '--preflight') { options.preflight = next; index += 1; continue }
    if (arg === '--help' || arg === '-h') return { help: true }
    throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.root || !options.input) throw new Error('--root and --input are required')
  return options
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('Usage: node update.mjs --root <target-repo> --input <verified-facts.json> [--preflight <preflight.json>]')
    return 0
  }
  const facts = readJson(path.resolve(options.input))
  const result = updateProjectMemory({
    ...facts,
    root: options.root,
    preflightSnapshot: options.preflight ? readJson(path.resolve(options.preflight)) : facts.preflightSnapshot,
  })
  console.log(JSON.stringify(result, null, 2))
  return 0
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
