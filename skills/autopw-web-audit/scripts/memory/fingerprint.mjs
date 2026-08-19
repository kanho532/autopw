import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRECTORIES = new Set(['.autopw', '.git', '.gradle', '.m2', '.cache', 'autopw-output', 'node_modules', 'dist', 'build'])

function isFingerprintInput(filePath) {
  const name = path.basename(filePath)
  return name === 'package.json' ||
    /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(name) ||
    /^pom\.xml$/.test(name) ||
    /^build\.gradle(?:\.kts)?$/.test(name) ||
    /^settings\.gradle(?:\.kts)?$/.test(name) ||
    /^application\.(?:yml|yaml|properties)$/.test(name) ||
    /^vite\.config\./.test(name) ||
    /^playwright\.config\./.test(name) ||
    name === '.env.example' ||
    name === 'Dockerfile' ||
    /^docker-compose(?:\..*)?$/.test(name) ||
    /^compose(?:\..*)?$/.test(name)
}

function walkFiles(root) {
  const result = []
  function visit(current, depth) {
    if (depth > 8) return
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) visit(entryPath, depth + 1)
      else if (entry.isFile() && isFingerprintInput(entryPath)) result.push(entryPath)
    }
  }
  if (fs.existsSync(root)) visit(root, 0)
  return result
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function collectFingerprintFiles(root) {
  const resolvedRoot = path.resolve(root)
  return walkFiles(resolvedRoot)
    .map((filePath) => ({
      path: path.relative(resolvedRoot, filePath).split(path.sep).join('/'),
      sha256: sha256File(filePath),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export function computeProjectFingerprint(root) {
  const files = collectFingerprintFiles(root)
  const digest = crypto.createHash('sha256')
  for (const file of files) digest.update(`${file.path}\0${file.sha256}\n`)
  return { project_fingerprint: digest.digest('hex'), fingerprint_files: files }
}

export function fingerprintMatches(memory, fingerprint) {
  if (!memory || !fingerprint) return false
  return memory.project_fingerprint === fingerprint.project_fingerprint
}
