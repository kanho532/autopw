const EXECUTOR_NAMES = new Set([
  'DIRECT_API',
  'PLAYWRIGHT_TEST',
  'STATIC',
  'LOG_STATE',
  'MCP_DIAGNOSTIC'
])

export function assertExecutorMap(executors) {
  if (!executors || typeof executors !== 'object') throw new Error('Executor module must export an executor map')
  for (const [name, executor] of Object.entries(executors)) {
    if (!EXECUTOR_NAMES.has(name)) throw new Error(`Unknown executor: ${name}`)
    if (typeof executor !== 'function') throw new Error(`Executor ${name} must be a function`)
  }
  return executors
}

export async function executeCase(executors, name, testCase, context) {
  const executor = executors[name]
  if (typeof executor !== 'function') throw new Error(`Executor unavailable: ${name}`)
  const result = await executor(testCase, context)
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${name} returned a non-object result for ${testCase.id}`)
  }
  if (result.case_id !== testCase.id || result.attempt !== context.attempt) {
    throw new Error(`${name} returned a mismatched case_id or attempt for ${testCase.id}`)
  }
  return result
}
