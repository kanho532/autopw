import { assertSchema } from '../lib/schema-validator.mjs'
import { routeCase } from './transition.mjs'

export { evaluateEvidence } from './evidence.mjs'
export { compareExecutionContexts, compareSignatures } from './signature.mjs'
export { routeCase } from './transition.mjs'

export function routeInput(input) {
  assertSchema('router-input', input)
  const expected = input.expected_case_ids
  const actual = input.cases.map((testCase) => testCase.case_id)
  const missing = expected.filter((caseId) => !actual.includes(caseId))
  const unexpected = actual.filter((caseId) => !expected.includes(caseId))
  const duplicateActual = actual.filter((caseId, index) => actual.indexOf(caseId) !== index)
  if (duplicateActual.length || missing.length || unexpected.length) {
    throw new Error(
      `Frozen case coverage mismatch: ${JSON.stringify({ duplicate_actual: [...new Set(duplicateActual)], missing, unexpected })}`
    )
  }
  const output = {
    run_id: input.run_id,
    decisions: input.cases.map((testCase) => routeCase(testCase, input.artifacts_root))
  }
  assertSchema('router-decision', output)
  return output
}
