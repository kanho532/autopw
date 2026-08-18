function textOf(error) {
  return String(error?.message ?? error ?? '').replace(/\u001b\[[0-9;]*m/g, '')
}

function classifyPlaywrightFailure(error, context = {}) {
  const message = textOf(error)
  const operation = String(context.operation ?? '').toUpperCase()
  if (/strict mode violation|resolved to \d+ elements|locator.*matched \d+/i.test(message)) return 'LOCATOR'
  if (/expect\s*\(|expect\b.*failed|Expected(?: substring)?:|Received:/i.test(message)) return 'ASSERTION'
  if (/requestfailed|net::ERR_|socket hang up|ECONN(?:RESET|REFUSED)/i.test(message)) return 'REQUEST_FAILED'
  if (/pageerror|uncaught|unhandled promise rejection/i.test(message)) return 'PAGE_ERROR'
  if (operation === 'NAVIGATION' || /page\.goto|navigation.*(?:failed|timeout)|ERR_NAME_NOT_RESOLVED/i.test(message)) {
    return 'NAVIGATION'
  }
  if (/Test timeout of \d+ms exceeded|TimeoutError|waiting for.*timed out|timeout.*exceeded/i.test(message)) return 'TIMEOUT'
  if (/browser.*(?:launch|closed)|spawn |ENOENT|EINVAL|executable doesn't exist/i.test(message)) return 'INFRASTRUCTURE'
  return 'ASSERTION'
}

module.exports = { classifyPlaywrightFailure, textOf }

