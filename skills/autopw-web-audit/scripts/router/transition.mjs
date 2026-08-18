import { validateSchema } from '../lib/schema-validator.mjs'
import { MCP_TRIGGERS } from './constants.mjs'
import { evaluateEvidence } from './evidence.mjs'
import { compareExecutionContexts, compareSignatures, failureSignatureErrors } from './signature.mjs'
import { timingSummary, validateTiming } from './timing.mjs'

function invalidDecision(caseId, reasonCode, details = {}) {
  return { case_id: caseId ?? 'UNKNOWN', next_action: 'INVALID_RESULT', reason_code: reasonCode, ...details }
}

function done(caseId, finalStatus, reasonCode, timing, details = {}) {
  return {
    case_id: caseId,
    next_action: 'DONE',
    final_status: finalStatus,
    reason_code: reasonCode,
    ...details,
    timing
  }
}

function mcpAction(testCase, requiredTrigger, reasonCode, timing, details = {}) {
  if (!MCP_TRIGGERS.has(requiredTrigger) || testCase.mcp_trigger !== requiredTrigger) {
    return done(testCase.case_id, 'BLOCKED', 'MCP.TRIGGER_NOT_FROZEN', timing, {
      required_trigger: requiredTrigger,
      ...details
    })
  }
  return {
    case_id: testCase.case_id,
    next_action: 'START_MCP',
    reason_code: reasonCode,
    ...details,
    timing
  }
}

export function routeCase(testCase, artifactsRoot) {
  const schema = validateSchema('router-case', testCase)
  if (!schema.valid) {
    return invalidDecision(testCase?.case_id, 'RESULT.INVALID_SCHEMA', {
      missing_evidence: schema.errors.map((error) => `${error.path}:${error.keyword}`)
    })
  }

  const { case_id: caseId, attempts } = testCase
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]
    if (attempt.case_id !== caseId || attempt.attempt !== index + 1) {
      return invalidDecision(caseId, 'EXECUTION.ATTEMPT_SEQUENCE_MISMATCH')
    }
    const timingErrors = validateTiming(attempt.timing)
    if (timingErrors.length > 0) {
      return invalidDecision(caseId, 'EXECUTION.INVALID_TIMING', { missing_evidence: timingErrors })
    }
    if (attempt.status === 'FAIL') {
      const signatureErrors = failureSignatureErrors(attempt, caseId)
      if (signatureErrors.length > 0) {
        return invalidDecision(caseId, 'RESULT.INVALID_FAILURE_SIGNATURE', {
          missing_evidence: signatureErrors
        })
      }
    }
  }

  if (attempts.length === 2) {
    if (attempts[0].status !== 'FAIL' || !['PASS', 'FAIL'].includes(attempts[1].status)) {
      return invalidDecision(caseId, 'REPLAY.INVALID_SEQUENCE')
    }
    const contextComparison = compareExecutionContexts(
      attempts[0].execution_context,
      attempts[1].execution_context
    )
    if (!contextComparison.same || attempts[0].isolation_id === attempts[1].isolation_id) {
      return invalidDecision(caseId, 'REPLAY.CONTEXT_CHANGED', {
        context_differences: contextComparison.differences,
        isolation_reused: attempts[0].isolation_id === attempts[1].isolation_id
      })
    }
  }

  const timing = timingSummary(attempts)
  const latest = attempts.at(-1)
  if (latest.status === 'PASS') {
    return attempts.length === 2
      ? done(caseId, 'FLAKY', 'REPLAY.PASSED', timing)
      : done(caseId, 'PASS', 'EXECUTION.PASSED', timing)
  }
  if (latest.status === 'NOT_RUN') return done(caseId, 'NOT_RUN', `NOT_RUN.${latest.not_run.code}`, timing)
  if (latest.status === 'BLOCKED') return done(caseId, 'BLOCKED', `BLOCKED.${latest.blocked.code}`, timing)
  if (latest.failure_type === 'INFRASTRUCTURE') {
    const evidence = evaluateEvidence(latest, artifactsRoot)
    return done(caseId, 'BLOCKED', 'EXECUTION.INFRASTRUCTURE_FAILURE', timing, {
      missing_evidence: evidence.missing
    })
  }

  const evidence = evaluateEvidence(latest, artifactsRoot)
  if (evidence.complete) return done(caseId, 'FAIL', 'EVIDENCE.COMPLETE', timing)
  if (attempts.length === 1) {
    return {
      case_id: caseId,
      next_action: 'REPLAY_ONCE',
      reason_code: 'EVIDENCE.INCOMPLETE',
      missing_evidence: evidence.missing,
      timing
    }
  }

  const signature = compareSignatures(attempts[0].failure_signature, latest.failure_signature)
  if (!signature.same) {
    return done(caseId, 'FLAKY', 'REPLAY.SIGNATURE_CHANGED', timing, {
      signature_differences: signature.differences,
      missing_evidence: evidence.missing
    })
  }

  const apiMismatch = testCase.api_counterpart?.status === 'PASS' && testCase.api_counterpart?.same_business_invariant === true
  if (apiMismatch && testCase.mcp_trigger === 'API_BROWSER_MISMATCH') {
    return mcpAction(testCase, 'API_BROWSER_MISMATCH', 'MCP.API_BROWSER_MISMATCH', timing, {
      missing_evidence: evidence.missing,
      failure_signature: latest.failure_signature
    })
  }
  return mcpAction(
    testCase,
    'PLAYWRIGHT_FAILS_WITH_INCOMPLETE_EVIDENCE',
    'MCP.SAME_FAILURE_EVIDENCE_INCOMPLETE',
    timing,
    { missing_evidence: evidence.missing, failure_signature: latest.failure_signature }
  )
}
