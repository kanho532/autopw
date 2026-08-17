#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const FAILURE_TYPES = new Set([
  'ASSERTION',
  'LOCATOR',
  'REQUEST_FAILED',
  'PAGE_ERROR',
  'NAVIGATION',
  'TIMEOUT',
  'INFRASTRUCTURE'
])

const MCP_TRIGGERS = new Set([
  'PLAYWRIGHT_FAILS_WITH_INCOMPLETE_EVIDENCE',
  'API_BROWSER_MISMATCH'
])

const SIGNATURE_FIELDS = [
  'case_id',
  'failure_type',
  'route',
  'assertion',
  'locator',
  'http_method',
  'http_status',
  'top_stack_frame'
]

const ARTIFACT_FIELDS = new Set(['dom_state', 'trace', 'screenshot'])

const REPLAY_CONTEXT_FIELDS = [
  'runner',
  'runner_version',
  'browser',
  'browser_build',
  'locale',
  'timezone',
  'spec_path',
  'test_title',
  'storage_state_contract'
]

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalized(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim().replace(/\s+/g, ' ')
}

function artifactExists(artifactsRoot, value) {
  if (!hasText(value)) return false
  const root = path.resolve(artifactsRoot)
  const candidate = path.resolve(root, value)
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  return fs.existsSync(candidate)
}

function validateTiming(timing) {
  if (!isObject(timing)) return ['timing']
  const missing = []
  const started = Date.parse(timing.started_at)
  const finished = Date.parse(timing.finished_at)
  if (!Number.isFinite(started)) missing.push('timing.started_at')
  if (!Number.isFinite(finished)) missing.push('timing.finished_at')
  if (!Number.isFinite(timing.duration_ms) || timing.duration_ms < 0) {
    missing.push('timing.duration_ms')
  }
  if (
    Number.isFinite(started) &&
    Number.isFinite(finished) &&
    Number.isFinite(timing.duration_ms) &&
    Math.abs(finished - started - timing.duration_ms) > 1000
  ) {
    missing.push('timing.consistency')
  }
  return missing
}

function validateFailureSignature(signature, attempt, caseId) {
  if (!isObject(signature)) return ['failure_signature']
  const missing = []
  for (const field of SIGNATURE_FIELDS) {
    if (!Object.hasOwn(signature, field)) missing.push(`failure_signature.${field}`)
  }
  if (signature.case_id !== caseId) missing.push('failure_signature.case_id')
  if (signature.failure_type !== attempt.failure_type) {
    missing.push('failure_signature.failure_type')
  }
  return [...new Set(missing)]
}

function validateExecutionContext(attempt) {
  const context = attempt?.execution_context
  if (!isObject(context)) return ['execution_context']
  const missing = []
  for (const field of REPLAY_CONTEXT_FIELDS) {
    if (!hasText(context[field])) missing.push(`execution_context.${field}`)
  }
  if (
    !isObject(context.viewport) ||
    !Number.isInteger(context.viewport.width) ||
    !Number.isInteger(context.viewport.height) ||
    context.viewport.width < 1 ||
    context.viewport.height < 1
  ) {
    missing.push('execution_context.viewport')
  }
  for (const field of ['steps', 'assertions', 'locator_contract']) {
    if (!Array.isArray(context[field]) || context[field].length === 0 || !context[field].every(hasText)) {
      missing.push(`execution_context.${field}`)
    }
  }
  if (!hasText(attempt?.isolation_id)) missing.push('isolation_id')
  return missing
}

function normalizedArray(value) {
  return Array.isArray(value) ? value.map(normalized) : []
}

export function compareExecutionContexts(left, right) {
  const differences = []
  for (const field of REPLAY_CONTEXT_FIELDS) {
    if (normalized(left?.[field]) !== normalized(right?.[field])) differences.push(field)
  }
  if (left?.viewport?.width !== right?.viewport?.width) differences.push('viewport.width')
  if (left?.viewport?.height !== right?.viewport?.height) differences.push('viewport.height')
  for (const field of ['steps', 'assertions', 'locator_contract']) {
    if (JSON.stringify(normalizedArray(left?.[field])) !== JSON.stringify(normalizedArray(right?.[field]))) {
      differences.push(field)
    }
  }
  return { same: differences.length === 0, differences }
}

function requireArtifact(evidence, field, artifactsRoot, missing) {
  if (!artifactExists(artifactsRoot, evidence?.[field])) {
    missing.push(`evidence.${field}`)
  }
}

function requireText(container, field, prefix, missing) {
  if (!hasText(container?.[field])) missing.push(`${prefix}.${field}`)
}

export function evaluateEvidence(attempt, artifactsRoot) {
  const missing = validateTiming(attempt?.timing)
  if (!isObject(attempt) || attempt.status !== 'FAIL') {
    return { complete: missing.length === 0, missing }
  }

  if (!FAILURE_TYPES.has(attempt.failure_type)) {
    missing.push('failure_type')
    return { complete: false, missing }
  }

  const evidence = attempt.evidence
  if (!isObject(evidence)) {
    missing.push('evidence')
    return { complete: false, missing }
  }

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
    case 'REQUEST_FAILED': {
      const request = evidence.request
      if (!isObject(request)) {
        missing.push('evidence.request')
      } else {
        requireText(request, 'method', 'evidence.request', missing)
        requireText(request, 'url', 'evidence.request', missing)
        if (!Number.isInteger(request.status) && !hasText(request.error)) {
          missing.push('evidence.request.status_or_error')
        }
      }
      requireArtifact(evidence, 'trace', artifactsRoot, missing)
      break
    }
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
    case 'INFRASTRUCTURE': {
      const infrastructure = evidence.infrastructure
      if (!isObject(infrastructure)) {
        missing.push('evidence.infrastructure')
      } else {
        requireText(infrastructure, 'health_check', 'evidence.infrastructure', missing)
        requireText(infrastructure, 'command', 'evidence.infrastructure', missing)
        if (!Number.isInteger(infrastructure.exit_code) && !hasText(infrastructure.port_state)) {
          missing.push('evidence.infrastructure.exit_code_or_port_state')
        }
      }
      break
    }
  }

  return { complete: missing.length === 0, missing }
}

export function compareSignatures(left, right) {
  const differences = []
  for (const field of SIGNATURE_FIELDS) {
    if (normalized(left?.[field]) !== normalized(right?.[field])) differences.push(field)
  }
  return { same: differences.length === 0, differences }
}

function invalidDecision(caseId, reasonCode, details = {}) {
  return {
    case_id: caseId ?? 'UNKNOWN',
    next_action: 'INVALID_RESULT',
    reason_code: reasonCode,
    ...details
  }
}

function timingSummary(attempts) {
  return {
    attempts: attempts.map(({ attempt, timing }) => ({ attempt, ...timing })),
    total_duration_ms: attempts.reduce(
      (total, item) => total + (Number.isFinite(item?.timing?.duration_ms) ? item.timing.duration_ms : 0),
      0
    )
  }
}

function mcpAction(testCase, requiredTrigger, reasonCode, extra = {}) {
  if (!MCP_TRIGGERS.has(requiredTrigger) || testCase.mcp_trigger !== requiredTrigger) {
    return {
      case_id: testCase.case_id,
      next_action: 'BLOCKED_DIAGNOSTIC',
      reason_code: 'MCP_TRIGGER_NOT_FROZEN',
      required_trigger: requiredTrigger,
      ...extra
    }
  }
  return {
    case_id: testCase.case_id,
    next_action: 'START_MCP',
    reason_code: reasonCode,
    ...extra
  }
}

export function routeCase(testCase, artifactsRoot) {
  const caseId = testCase?.case_id
  const attempts = testCase?.attempts
  if (!hasText(caseId) || !Array.isArray(attempts) || attempts.length < 1 || attempts.length > 2) {
    return invalidDecision(caseId, 'INVALID_ATTEMPT_COUNT')
  }

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]
    if (attempt.case_id !== caseId || attempt.attempt !== index + 1) {
      return invalidDecision(caseId, 'ATTEMPT_ID_OR_SEQUENCE_MISMATCH')
    }
    if (!['PASS', 'FAIL', 'BLOCKED'].includes(attempt.status)) {
      return invalidDecision(caseId, 'INVALID_STATUS')
    }
    const timingErrors = validateTiming(attempt.timing)
    if (timingErrors.length > 0) {
      return invalidDecision(caseId, 'INVALID_TIMING', { missing_evidence: timingErrors })
    }
    const contextErrors = validateExecutionContext(attempt)
    if (contextErrors.length > 0) {
      return invalidDecision(caseId, 'INVALID_EXECUTION_CONTEXT', {
        missing_evidence: contextErrors
      })
    }
  }

  if (attempts.length === 2) {
    const contextComparison = compareExecutionContexts(
      attempts[0].execution_context,
      attempts[1].execution_context
    )
    if (!contextComparison.same || attempts[0].isolation_id === attempts[1].isolation_id) {
      return invalidDecision(caseId, 'INVALID_REPLAY_CONTEXT', {
        context_differences: contextComparison.differences,
        isolation_reused: attempts[0].isolation_id === attempts[1].isolation_id
      })
    }
  }

  const timing = timingSummary(attempts)
  const latest = attempts.at(-1)
  if (latest.status === 'PASS') {
    if (attempts.length === 2 && attempts[0].status === 'FAIL') {
      return {
        case_id: caseId,
        next_action: 'FLAKY_CANDIDATE',
        reason_code: 'CLEAN_REPLAY_PASSED',
        timing
      }
    }
    return { case_id: caseId, next_action: 'DONE_PASS', reason_code: 'PLAYWRIGHT_PASSED', timing }
  }

  if (latest.status === 'BLOCKED' || latest.failure_type === 'INFRASTRUCTURE') {
    const evidence = evaluateEvidence(latest, artifactsRoot)
    return {
      case_id: caseId,
      next_action: 'BLOCKED_INFRA',
      reason_code: 'INFRASTRUCTURE_FAILURE',
      missing_evidence: evidence.missing,
      timing
    }
  }

  const signatureErrors = validateFailureSignature(latest.failure_signature, latest, caseId)
  if (signatureErrors.length > 0) {
    return invalidDecision(caseId, 'INVALID_FAILURE_SIGNATURE', {
      missing_evidence: signatureErrors
    })
  }

  const evidence = evaluateEvidence(latest, artifactsRoot)
  if (evidence.complete) {
    return {
      case_id: caseId,
      next_action: 'DONE_FAIL',
      reason_code: 'FAILURE_EVIDENCE_COMPLETE',
      timing
    }
  }

  if (attempts.length === 1) {
    return {
      case_id: caseId,
      next_action: 'REPLAY_ONCE',
      reason_code: 'PLAYWRIGHT_FAILED_EVIDENCE_INCOMPLETE',
      missing_evidence: evidence.missing,
      timing
    }
  }

  const signature = compareSignatures(attempts[0].failure_signature, latest.failure_signature)
  if (!signature.same) {
    return {
      case_id: caseId,
      next_action: 'FLAKY_CANDIDATE',
      reason_code: 'FAILURE_SIGNATURE_CHANGED',
      signature_differences: signature.differences,
      missing_evidence: evidence.missing,
      timing
    }
  }

  const apiMismatch =
    testCase.api_counterpart?.status === 'PASS' &&
    testCase.api_counterpart?.same_business_invariant === true

  if (apiMismatch && testCase.mcp_trigger === 'API_BROWSER_MISMATCH') {
    return {
      ...mcpAction(testCase, 'API_BROWSER_MISMATCH', 'API_BROWSER_MISMATCH', {
        missing_evidence: evidence.missing,
        failure_signature: latest.failure_signature
      }),
      timing
    }
  }

  return {
    ...mcpAction(
      testCase,
      'PLAYWRIGHT_FAILS_WITH_INCOMPLETE_EVIDENCE',
      'SAME_FAILURE_EVIDENCE_INCOMPLETE',
      {
      missing_evidence: evidence.missing,
      failure_signature: latest.failure_signature
      }
    ),
    timing
  }
}

export function routeInput(input) {
  if (!isObject(input) || !hasText(input.run_id) || !hasText(input.artifacts_root)) {
    throw new Error('Input requires non-empty run_id and artifacts_root')
  }
  if (!Array.isArray(input.expected_case_ids) || input.expected_case_ids.length === 0) {
    throw new Error('Input requires a non-empty expected_case_ids array')
  }
  if (!Array.isArray(input.cases)) throw new Error('Input requires a cases array')
  const expected = input.expected_case_ids
  const actual = input.cases.map((testCase) => testCase?.case_id)
  const duplicateExpected = expected.filter((caseId, index) => expected.indexOf(caseId) !== index)
  const duplicateActual = actual.filter((caseId, index) => actual.indexOf(caseId) !== index)
  const missing = expected.filter((caseId) => !actual.includes(caseId))
  const unexpected = actual.filter((caseId) => !expected.includes(caseId))
  if (duplicateExpected.length || duplicateActual.length || missing.length || unexpected.length) {
    throw new Error(
      `Frozen case coverage mismatch: ${JSON.stringify({
        duplicate_expected: [...new Set(duplicateExpected)],
        duplicate_actual: [...new Set(duplicateActual)],
        missing,
        unexpected
      })}`
    )
  }
  return {
    run_id: input.run_id,
    decisions: input.cases.map((testCase) => routeCase(testCase, input.artifacts_root))
  }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--input' || item === '--output') {
      args[item.slice(2)] = argv[index + 1]
      index += 1
    } else if (item === '--help' || item === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${item}`)
    }
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.input) {
    process.stdout.write('Usage: node autopw-router.mjs --input <router-input.json> [--output <decisions.json>]\n')
    process.exitCode = args.help ? 0 : 2
    return
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf8'))
  const output = `${JSON.stringify(routeInput(input), null, 2)}\n`
  if (args.output) {
    const outputPath = path.resolve(args.output)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, output, 'utf8')
  } else {
    process.stdout.write(output)
  }
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  }
}
