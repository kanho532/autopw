import { REPLAY_CONTEXT_FIELDS, SIGNATURE_FIELDS } from './constants.mjs'

function normalized(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim().replace(/\s+/g, ' ')
}

function normalizedArray(value) {
  return Array.isArray(value)
    ? value.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return normalized(item)
        return Object.fromEntries(
          Object.entries(item)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, normalized(nested)])
        )
      })
    : []
}

export function compareSignatures(left, right) {
  const differences = []
  for (const field of SIGNATURE_FIELDS) {
    if (normalized(left?.[field]) !== normalized(right?.[field])) differences.push(field)
  }
  return { same: differences.length === 0, differences }
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

export function failureSignatureErrors(attempt, caseId) {
  const errors = []
  if (attempt.failure_signature?.case_id !== caseId) errors.push('failure_signature.case_id')
  if (attempt.failure_signature?.failure_type !== attempt.failure_type) {
    errors.push('failure_signature.failure_type')
  }
  return errors
}
