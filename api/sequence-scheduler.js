'use strict'

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Computes when a sequence step should be scheduled.
 * Returns a Date if the step should fire, or null if it should be skipped.
 *
 * For 'previous_step' (or missing) timing_anchor: returns now + delay_days + delay_hours.
 * For 'fixed_date': returns fixed_send_at if it is >= 3 days away from now,
 *   otherwise null (date is past or within the 3-day minimum gap).
 *
 * @param {Object} step - sequence_steps row
 * @param {Date} now - reference time (previous step's send time, or enrollment time)
 * @returns {Date|null}
 */
function computeNextSendTime(step, now) {
  if (step.timing_anchor === 'fixed_date') {
    if (!step.fixed_send_at) return null

    const fixedAt = new Date(step.fixed_send_at)
    const minGapCutoff = new Date(now.getTime() + THREE_DAYS_MS)

    if (fixedAt < minGapCutoff) return null

    return fixedAt
  }

  // Default: 'previous_step' relative timing (also handles missing timing_anchor)
  const next = new Date(now)
  next.setDate(next.getDate() + (step.delay_days || 0))
  next.setTime(next.getTime() + (step.delay_hours || 0) * 60 * 60 * 1000)
  return next
}

module.exports = { computeNextSendTime }
