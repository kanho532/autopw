import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SUPPORTED_PACKAGES = new Set(['@playwright/test', 'playwright'])
export const PLAYWRIGHT_MODES = new Set(['AUTOPW_RUNTIME', 'PROJECT_NATIVE'])
const DEFAULT_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

function readPackage(packageRoot) {
  const manifestPath = path.join(packageRoot, 'package.json')
  if (!fs.existsSync(manifestPath)) return null
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!SUPPORTED_PACKAGES.has(manifest.name)) return null
  return { manifest, manifestPath }
}

function packageCandidates(root) {
  const resolved = path.resolve(root)
  return [
    resolved,
    path.join(resolved, 'node_modules', '@playwright', 'test'),
    path.join(resolved, 'node_modules', 'playwright'),
    path.join(resolved, '@playwright', 'test'),
    path.join(resolved, 'playwright')
  ]
}

export function inspectPlaywrightRuntime(packageRoot) {
  const resolvedRoot = path.resolve(packageRoot)
  const packageData = readPackage(resolvedRoot)
  if (!packageData) {
    throw new Error(`Expected a playwright or @playwright/test package root: ${resolvedRoot}`)
  }

  const { manifest, manifestPath } = packageData
  const cliPath = path.join(resolvedRoot, 'cli.js')
  const testModulePath = path.join(resolvedRoot, manifest.name === 'playwright' ? 'test.js' : 'index.js')
  for (const requiredPath of [cliPath, testModulePath]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Playwright runtime ${manifest.name}@${manifest.version} is missing ${requiredPath}`)
    }
  }

  return {
    package_name: manifest.name,
    version: String(manifest.version),
    package_root: resolvedRoot,
    manifest_path: manifestPath,
    cli_path: cliPath,
    test_module_path: testModulePath
  }
}

export function resolveBundledPlaywrightRuntime({ pluginRoot = DEFAULT_PLUGIN_ROOT, packageRoot } = {}) {
  const resolvedPackageRoot = packageRoot ?? path.join(path.resolve(pluginRoot), 'node_modules', '@playwright', 'test')
  const runtime = inspectPlaywrightRuntime(resolvedPackageRoot)
  return {
    ...runtime,
    browser_root: path.resolve(resolvedPackageRoot, '../../playwright-core/.local-browsers')
  }
}

export function resolveProjectPlaywrightRuntime({ projectRoot, packageRoot, searchRoots = [] } = {}) {
  const roots = [packageRoot, projectRoot, ...searchRoots].filter(Boolean)
  const visited = new Set()
  const rejected = []

  for (const root of roots) {
    for (const candidate of packageCandidates(root)) {
      const normalized = path.resolve(candidate)
      if (visited.has(normalized)) continue
      visited.add(normalized)
      try {
        return inspectPlaywrightRuntime(normalized)
      } catch (error) {
        rejected.push(error.message)
      }
    }
  }

  throw new Error(
    `No single Playwright Test runtime was found. Provide packageRoot or a version-pinned searchRoot. Checked: ${[
      ...visited
    ].join(', ')}${rejected.length ? `. Last error: ${rejected.at(-1)}` : ''}`
  )
}

export function resolvePlaywrightRuntime(options = {}) {
  if (options.mode === 'AUTOPW_RUNTIME') return resolveBundledPlaywrightRuntime(options)
  if (options.mode === 'PROJECT_NATIVE') return resolveProjectPlaywrightRuntime(options)
  return resolveProjectPlaywrightRuntime(options)
}

export function relativePlaywrightSpec(testDir, specPath) {
  const resolvedTestDir = path.resolve(testDir)
  const resolvedSpec = path.resolve(specPath)
  const relative = path.relative(resolvedTestDir, resolvedSpec)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Playwright spec must be a file below testDir: ${resolvedSpec}`)
  }
  return relative.split(path.sep).join('/')
}

export function playwrightCliInvocation({ runtime, testDir, configPath, specPaths, list = false, nodeOptions = [] }) {
  if (!runtime?.cli_path || !runtime?.test_module_path) {
    throw new Error('A resolved Playwright runtime is required')
  }
  const selectedSpecs = (specPaths ?? []).map((specPath) => relativePlaywrightSpec(testDir, specPath))
  const args = [runtime.cli_path, 'test', ...selectedSpecs, '--config', path.resolve(configPath)]
  if (list) args.push('--list')
  return { command: process.execPath, args: [...nodeOptions, ...args] }
}
