import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const PLAYWRIGHT_PACKAGES = new Set(['@playwright/test', 'playwright'])
const PACKAGE_MANAGERS = [
  { name: 'npm', lockfile: 'package-lock.json', command: 'npm' },
  { name: 'pnpm', lockfile: 'pnpm-lock.yaml', command: 'pnpm' },
  { name: 'yarn', lockfile: 'yarn.lock', command: 'yarn' },
  { name: 'bun', lockfile: 'bun.lockb', command: 'bun' },
]
const PORT_ENV_NAMES = ['PORT', 'API_PORT', 'BACKEND_PORT', 'FRONTEND_PORT', 'SERVER_PORT', 'VITE_PORT', 'PLAYWRIGHT_PORT']
const SKIP_DIRECTORIES = new Set(['.git', '.gradle', '.m2', '.cache', 'autopw-output', 'node_modules'])
const CHROMIUM_EXECUTABLES = new Set(['chrome.exe', 'chrome', 'chromium', 'Chromium', 'Google Chrome for Testing'])

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function commandCandidates(command) {
  if (process.platform !== 'win32' || /\.(?:cmd|bat|exe)$/i.test(command)) return [command]
  return [command, `${command}.cmd`]
}

function spawnTool(candidate, args, options) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidate)) {
    const quote = (value) => /[\s"]/.test(value) ? `"${String(value).replaceAll('"', '\\"')}"` : String(value)
    const commandLine = [candidate, ...args].map(quote).join(' ')
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], options)
  }
  return spawnSync(candidate, args, options)
}

export function probeCommand(command, args = [], { env = process.env } = {}) {
  let lastFailure = {
    available: false,
    error_code: 'COMMAND_FAILED',
    detail: `Command failed: ${command}`,
  }

  for (const candidate of commandCandidates(command)) {
    try {
      const result = spawnTool(candidate, args, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        env,
      })
      const stdout = text(result.stdout)
      const stderr = text(result.stderr)
      if (!result.error && result.status === 0) {
        return { available: true, command: candidate, stdout, stderr, detail: stdout || stderr || `${candidate} exited successfully` }
      }
      const timedOut = result.signal === 'SIGTERM' || result.signal === 'SIGKILL'
      lastFailure = {
        available: false,
        command: candidate,
        error_code: timedOut ? 'TIMEOUT' : 'COMMAND_FAILED',
        detail: stderr || stdout || result.error?.message || `${candidate} exited with status ${result.status}`,
      }
      if (result.error?.code !== 'ENOENT') break
    } catch (error) {
      lastFailure = {
        available: false,
        command: candidate,
        error_code: error.code === 'ENOENT' ? 'NOT_FOUND' : 'COMMAND_FAILED',
        detail: error.message,
      }
      if (error.code !== 'ENOENT') break
    }
  }

  if (lastFailure.error_code === 'COMMAND_FAILED' && /Command failed/.test(lastFailure.detail)) lastFailure.error_code = 'NOT_FOUND'
  return lastFailure
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function normalizeVersion(output, pattern = /v?(\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?)/i) {
  return text(output).match(pattern)?.[1] ?? null
}

function probeTool(command, args, versionPattern, env) {
  const result = probeCommand(command, args, { env })
  if (result.available) result.version = normalizeVersion(result.stdout || result.stderr, versionPattern)
  return result
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function walkFiles(root, { maxDepth = 5, maxFiles = 10000 } = {}) {
  const files = []
  function visit(current, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) visit(entryPath, depth + 1)
      else if (entry.isFile()) files.push(entryPath)
    }
  }
  if (fs.existsSync(root)) visit(root, 0)
  return files
}

function detectArtifacts(root) {
  const jars = walkFiles(root)
    .filter((filePath) => filePath.toLowerCase().endsWith('.jar'))
    .map((filePath) => relativePath(root, filePath))
    .sort()
  const fatJars = jars.filter((jar) => !/(?:[-.]sources|[-.]javadoc|[-.]tests?|[-.]original)\.jar$/i.test(jar))
  return {
    available: fatJars.length > 0,
    existing_jars: jars,
    fat_jars: fatJars,
    detail: fatJars.length ? `Found ${fatJars.length} candidate fat jar(s)` : 'No candidate fat jar found',
  }
}

function packageManagerProbe(root, packageJson, npmProbe, env) {
  const lockfile = PACKAGE_MANAGERS.find(({ lockfile: name }) => fs.existsSync(path.join(root, name)))
  const declared = text(packageJson?.packageManager).split('@')[0]
  const selected = lockfile ?? PACKAGE_MANAGERS.find(({ name }) => name === declared) ?? (packageJson ? PACKAGE_MANAGERS[0] : null)
  if (!selected) return { available: false, name: null, lockfile: null, detail: 'No package.json or recognized lockfile found' }
  const commandResult = selected.name === 'npm' ? npmProbe : probeCommand(selected.command, ['--version'], { env })
  return {
    ...commandResult,
    name: selected.name,
    lockfile: lockfile?.lockfile ?? null,
    detail: lockfile ? `Detected ${lockfile.lockfile}` : commandResult.detail,
  }
}

function playwrightPackageCandidates(root, configuredRoots) {
  const candidates = [
    path.join(root, 'node_modules', '@playwright', 'test'),
    path.join(root, 'node_modules', 'playwright'),
  ]
  for (const configuredRoot of configuredRoots) {
    const resolved = path.resolve(configuredRoot)
    candidates.push(resolved, path.join(resolved, 'node_modules', '@playwright', 'test'), path.join(resolved, 'node_modules', 'playwright'))
  }
  return [...new Set(candidates)]
}

function readPlaywrightPackage(packageRoot) {
  const manifestPath = path.join(packageRoot, 'package.json')
  const manifest = readJson(manifestPath)
  if (!manifest || !PLAYWRIGHT_PACKAGES.has(manifest.name)) return null
  return { package_name: manifest.name, version: String(manifest.version ?? 'unknown'), package_root: packageRoot, manifest_path: manifestPath }
}

function platformBrowserRoots(packageRoot, env) {
  const configured = text(env.PLAYWRIGHT_BROWSERS_PATH)
  if (configured === '0') return [path.join(packageRoot, '.local-browsers')]
  if (configured) return [path.resolve(configured)]
  if (process.platform === 'win32') return [path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')]
  if (process.platform === 'darwin') return [path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')]
  return [path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright')]
}

function findChromiumExecutable(browserRoot) {
  for (const filePath of walkFiles(browserRoot, { maxDepth: 6, maxFiles: 5000 })) {
    if (!CHROMIUM_EXECUTABLES.has(path.basename(filePath)) || !fs.existsSync(filePath)) continue
    if (/chromium|chrome/i.test(filePath)) return filePath
  }
  return null
}

function detectPlaywright(root, configuredRoots, browserRoots, env) {
  let runtime = null
  for (const candidate of playwrightPackageCandidates(root, configuredRoots)) {
    runtime = readPlaywrightPackage(candidate)
    if (runtime) break
  }
  if (!runtime) {
    return {
      available: false,
      package_name: null,
      version: null,
      package_root: null,
      browser: { chromium: { available: false, detail: 'Playwright package not found' } },
      detail: 'No @playwright/test or playwright package found',
    }
  }

  const roots = [...new Set([...browserRoots, ...platformBrowserRoots(runtime.package_root, env)])]
  let executablePath = null
  for (const browserRoot of roots) {
    executablePath = findChromiumExecutable(browserRoot)
    if (executablePath) break
  }
  return {
    available: true,
    ...runtime,
    browser: {
      chromium: {
        available: Boolean(executablePath),
        ...(executablePath ? { executable_path: executablePath } : {}),
        detail: executablePath ? 'Chromium executable found' : `Chromium executable not found in ${roots.join(', ')}`,
      },
    },
    detail: `${runtime.package_name}@${runtime.version} found`,
  }
}

function collectPortSources(root, packageJson, env) {
  const sources = new Map()
  const add = (port, source) => {
    const numeric = Number(port)
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) return
    if (!sources.has(numeric)) sources.set(numeric, new Set())
    sources.get(numeric).add(source)
  }

  for (const name of PORT_ENV_NAMES) if (env[name]) add(env[name], `env:${name}`)
  const files = [path.join(root, '.env'), path.join(root, '.env.example'), path.join(root, 'application.properties'), path.join(root, 'application.yml'), path.join(root, 'application.yaml')]
  for (const filePath of files) {
    const content = readText(filePath)
    for (const match of content.matchAll(/(?:PORT|port|server\.port)\s*[=:]\s*["']?(\d{2,5})/g)) add(match[1], relativePath(root, filePath))
  }
  for (const [name, script] of Object.entries(packageJson?.scripts ?? {})) {
    for (const match of String(script).matchAll(/(?:--port(?:=|\s+)|\bPORT\s*=\s*|localhost:)(\d{2,5})/gi)) add(match[1], `package.json#scripts.${name}`)
  }
  return sources
}

function inspectPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    const finish = (available, error = null) => {
      server.removeAllListeners()
      const result = { port, available, in_use: !available, ...(error ? { detail: error } : {}) }
      if (server.listening) server.close(() => resolve(result))
      else resolve(result)
    }
    server.once('error', (error) => finish(false, error.code || error.message))
    server.listen({ host: '127.0.0.1', port }, () => finish(true))
  })
}

async function detectTargetPorts(root, packageJson, env) {
  const sourceMap = collectPortSources(root, packageJson, env)
  const ports = await Promise.all([...sourceMap.keys()].sort((a, b) => a - b).map(inspectPort))
  return {
    available: ports.length > 0,
    ports: ports.map((item) => ({ ...item, sources: [...sourceMap.get(item.port)] })),
    detail: ports.length ? `Detected ${ports.length} target port(s)` : 'No target ports detected',
  }
}

export async function runPreflight({ root = process.cwd(), output = null, configuredPlaywrightRoots = [], browserRoots = [], env = process.env } = {}) {
  const resolvedRoot = path.resolve(root)
  const packageJson = readJson(path.join(resolvedRoot, 'package.json'))
  const node = probeTool(process.execPath, ['--version'], undefined, env)
  const npm = probeTool('npm', ['--version'], undefined, env)
  const java = probeTool('java', ['-version'], /version\s+["']?([^"'\s]+)/i, env)
  const maven = probeTool('mvn', ['--version'], /Apache Maven\s+([\w.-]+)/i, env)
  const git = probeTool('git', ['--version'], /git version\s+([\w.-]+)/i, env)
  const artifacts = detectArtifacts(resolvedRoot)
  const packageManager = packageManagerProbe(resolvedRoot, packageJson, npm, env)
  const configuredRoots = [...configuredPlaywrightRoots, env.AUTOPW_PLAYWRIGHT_PACKAGE_ROOT, env.AUTOPW_PLAYWRIGHT_ROOT, env.PLAYWRIGHT_PACKAGE_ROOT].filter(Boolean)
  const playwright = detectPlaywright(resolvedRoot, configuredRoots, browserRoots, env)
  const targetPorts = await detectTargetPorts(resolvedRoot, packageJson, env)

  const result = {
    root: resolvedRoot,
    git: { available: Boolean(git.available), version: git.version ?? null, detail: git.detail, repository: fs.existsSync(path.join(resolvedRoot, '.git')) },
    node: { available: Boolean(node.available), version: node.version ?? null, detail: node.detail },
    npm: { available: Boolean(npm.available), version: npm.version ?? null, detail: npm.detail },
    java: { available: Boolean(java.available), version: java.version ?? null, detail: java.detail },
    maven: { available: Boolean(maven.available), version: maven.version ?? null, detail: maven.detail, ...(maven.available ? {} : { error_code: maven.error_code }) },
    artifacts,
    package_manager: packageManager,
    playwright,
    target_ports: targetPorts,
    recommendation: {
      backend_start: artifacts.fat_jars.length ? 'EXISTING_JAR' : maven.available ? 'MAVEN' : packageManager.available ? 'PACKAGE_MANAGER' : 'UNKNOWN',
      browser_executor: playwright.browser.chromium.available ? 'PLAYWRIGHT_TEST' : 'UNAVAILABLE',
    },
  }

  if (output) {
    const outputPath = path.resolve(output)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }
  return result
}

function parseArgs(argv) {
  const options = { configuredPlaywrightRoots: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--root') { options.root = next; index += 1; continue }
    if (arg === '--output') { options.output = next; index += 1; continue }
    if (arg === '--playwright-root' || arg === '--playwright-package-root') { options.configuredPlaywrightRoots.push(next); index += 1; continue }
    throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.root) throw new Error('--root is required')
  if (!options.output) options.output = path.join(options.root, 'autopw-output', 'preflight.json')
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('Usage: node autopw-preflight.mjs --root <target-repo> --output <audit-root>/preflight.json [--playwright-root <package-root>]')
    return 0
  }
  const result = await runPreflight(options)
  console.log(JSON.stringify(result, null, 2))
  return 0
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 2
  })
}
