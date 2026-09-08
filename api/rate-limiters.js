'use strict'

const rateLimit = require('express-rate-limit')

// Webhook endpoints: SendGrid sends bursts. 200 req/min per IP is generous but bounded.
const WEBHOOK_CONFIG = { windowMs: 60_000, max: 200 }
const UPSERT_CONFIG  = { windowMs: 60_000, max: 60 }
const ENGAGEMENT_REPORTING_CONFIG = { windowMs: 60_000, max: 30 }

const webhookLimiter = rateLimit({ ...WEBHOOK_CONFIG, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } })
const upsertLimiter  = rateLimit({ ...UPSERT_CONFIG,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } })
const engagementReportingLimiter = rateLimit({ ...ENGAGEMENT_REPORTING_CONFIG, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } })

module.exports = {
  webhookLimiter,
  upsertLimiter,
  engagementReportingLimiter,
  WEBHOOK_CONFIG,
  UPSERT_CONFIG,
  ENGAGEMENT_REPORTING_CONFIG,
}
