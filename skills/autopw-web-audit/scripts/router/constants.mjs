export const FAILURE_TYPES = new Set([
  'ASSERTION',
  'LOCATOR',
  'REQUEST_FAILED',
  'PAGE_ERROR',
  'NAVIGATION',
  'TIMEOUT',
  'INFRASTRUCTURE'
])

export const MCP_TRIGGERS = new Set([
  'PLAYWRIGHT_FAILS_WITH_INCOMPLETE_EVIDENCE',
  'API_BROWSER_MISMATCH'
])

export const SIGNATURE_FIELDS = [
  'case_id',
  'failure_type',
  'route',
  'assertion',
  'locator',
  'http_method',
  'http_status',
  'top_stack_frame'
]

export const REPLAY_CONTEXT_FIELDS = [
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
