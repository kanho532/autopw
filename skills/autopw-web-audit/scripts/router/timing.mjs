export function validateTiming(timing) {
  const errors = []
  const started = Date.parse(timing?.started_at)
  const finished = Date.parse(timing?.finished_at)
  const duration = timing?.duration_ms
  if (!Number.isFinite(started)) errors.push('timing.started_at')
  if (!Number.isFinite(finished)) errors.push('timing.finished_at')
  if (!Number.isFinite(duration) || duration < 0) errors.push('timing.duration_ms')
  if (
    Number.isFinite(started) &&
    Number.isFinite(finished) &&
    Number.isFinite(duration) &&
    Math.abs(finished - started - duration) > 1000
  ) {
    errors.push('timing.consistency')
  }
  return errors
}

export function timingSummary(attempts) {
  return {
    attempts: attempts.map(({ attempt, timing }) => ({ attempt, ...timing })),
    total_duration_ms: attempts.reduce(
      (total, item) => total + (Number.isFinite(item?.timing?.duration_ms) ? item.timing.duration_ms : 0),
      0
    )
  }
}
