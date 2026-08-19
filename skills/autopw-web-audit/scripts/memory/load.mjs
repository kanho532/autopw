import fs from 'node:fs'
import path from 'node:path'

import { validateSchema } from '../lib/schema-validator.mjs'
import { fingerprintMatches } from './fingerprint.mjs'

export function projectMemoryPath(root) {
  return path.join(path.resolve(root), '.autopw', 'project-memory.json')
}

export function readProjectMemory(root) {
  const filePath = projectMemoryPath(root)
  if (!fs.existsSync(filePath)) return { path: filePath, status: 'MISSING', memory: null, errors: [] }

  try {
    const memory = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const validation = validateSchema('project-memory', memory)
    if (!validation.valid) return { path: filePath, status: 'INVALID', memory: null, errors: validation.errors }
    return { path: filePath, status: 'AVAILABLE', memory, errors: [] }
  } catch (error) {
    return { path: filePath, status: 'INVALID', memory: null, errors: [{ path: '/', message: error.message }] }
  }
}

export function loadProjectMemory(root) {
  return readProjectMemory(root).memory
}

export function memoryMatchesFingerprint(memory, fingerprint) {
  return fingerprintMatches(memory, fingerprint)
}
