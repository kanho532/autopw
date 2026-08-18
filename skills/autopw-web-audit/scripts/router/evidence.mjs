import fs from 'node:fs'
import path from 'node:path'

import { FAILURE_TYPES } from './constants.mjs'
import { validateTiming } from './timing.mjs'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function artifactExists(artifactsRoot, value) {
  if (!hasText(value)) return false
  const root = path.resolve(artifactsRoot)
  const candidate = path.resolve(root, value)
  const relative = path.relative(root, candidate)
  return !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(candidate)
}

function requireArtifact(evidence, field, artifactsRoot, missing) {
  if (!artifactExists(artifactsRoot, evidence?.[field])) missing.push(`evidence.${field}`)
}

function requireText(container, field, prefix, missing) {
  if (!hasText(container?.[field])) missing.push(`${prefix}.${field}`.replace(/^\./, ''))
}

export function evaluateEvidence(attempt, artifactsRoot) {
  const missing = validateTiming(attempt?.timing)
  if (attempt?.status !== 'FAIL') return { complete: missing.length === 0, missing }
  if (!FAILURE_TYPES.has(attempt.failure_type)) return { complete: false, missing: [...missing, 'failure_type'] }

  const evidence = attempt.evidence
  if (!isObject(evidence)) return { complete: false, missing: [...missing, 'evidence'] }

  switch (attempt.failure_type) {
    case 'ASSERTION':
      requireText(attempt, 'expected', '', missing)
      requireText(attempt, 'actual', '', missing)
      requireText(evidence, 'error', 'evidence', missing)
      requireText(evidence, 'final_url', 'evidence', missing)
      requireArtifact(evidence, 'dom_state', artifactsRoot, missing)
      requireArtifact(evidence, 'trace', artifactsRoot, missing)
      break
    case 'LOCATOR':
      requireText(attempt.failure_signature, 'locator', 'failure_signature', missing)
      requireText(evidence, 'final_url', 'evidence', missing)
      requireArtifact(evidence, 'dom_state', artifactsRoot, missing)
      requireArtifact(evidence, 'screenshot', artifactsRoot, missing)
      requireArtifact(evidence, 'trace', artifactsRoot, missing)
      break
    case 'REQUEST_FAILED':
      if (!isObject(evidence.request)) {
        missing.push('evidence.request')
      } else {
        requireText(evidence.request, 'method', 'evidence.request', missing)
        requireText(evidence.request, 'url', 'evidence.request', missing)
        if (!Number.isInteger(evidence.request.status) && !hasText(evidence.request.error)) {
          missing.push('evidence.request.status_or_error')
        }
      }
      requireArtifact(evidence, 'trace', artifactsRoot, missing)
      break
    case 'PAGE_ERROR':
      if (!isObject(evidence.page_error)) {
        missing.push('evidence.page_error')
      } else {
        requireText(evidence.page_error, 'message', 'evidence.page_error', missing)
        requireText(evidence.page_error, 'stack', 'evidence.page_error', missing)
      }
      requireArtifact(evidence, 'trace', artifactsRoot, missing)
      break
    case 'NAVIGATION':
      requireText(evidence, 'initial_url', 'evidence', missing)
      requireText(evidence, 'final_url', 'evidence', missing)
      if (!Number.isInteger(evidence.response_status) && !Array.isArray(evidence.redirect_chain)) {
        missing.push('evidence.response_status_or_redirect_chain')
      }
      requireArtifact(evidence, 'trace', artifactsRoot, missing)
      break
    case 'TIMEOUT':
      requireText(evidence, 'wait_condition', 'evidence', missing)
      requireText(evidence, 'final_url', 'evidence', missing)
      requireArtifact(evidence, 'dom_state', artifactsRoot, missing)
      requireArtifact(evidence, 'trace', artifactsRoot, missing)
      if (!Array.isArray(evidence.pending_requests) && !Array.isArray(evidence.request_failures)) {
        missing.push('evidence.pending_requests_or_request_failures')
      }
      break
    case 'INFRASTRUCTURE':
      if (!isObject(evidence.infrastructure)) {
        missing.push('evidence.infrastructure')
      } else {
        requireText(evidence.infrastructure, 'health_check', 'evidence.infrastructure', missing)
        requireText(evidence.infrastructure, 'command', 'evidence.infrastructure', missing)
        if (!Number.isInteger(evidence.infrastructure.exit_code) && !hasText(evidence.infrastructure.port_state)) {
          missing.push('evidence.infrastructure.exit_code_or_port_state')
        }
      }
      break
  }
  return { complete: missing.length === 0, missing }
}
