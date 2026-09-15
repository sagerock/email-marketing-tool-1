'use strict'

class CampaignClaimConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CampaignClaimConflictError'
    this.code = 'CAMPAIGN_CLAIM_CONFLICT'
  }
}

function isCampaignClaimConflictError(error) {
  return error?.code === 'CAMPAIGN_CLAIM_CONFLICT'
}

function canonicalEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

async function* keysetPages(fetchPage, pageSize = 1000) {
  let afterId = null
  let pageNumber = 1

  while (true) {
    const rows = await fetchPage({ afterId, limit: pageSize, pageNumber })
    if (!rows || rows.length === 0) return

    yield rows

    const nextId = rows[rows.length - 1]?.id
    if (!nextId || nextId === afterId) {
      throw new Error('Keyset pagination did not advance')
    }

    afterId = nextId
    pageNumber++
    if (rows.length < pageSize) return
  }
}

function isSchedulerEnabled(env = process.env) {
  return env.RUN_SCHEDULER === 'true'
}

function aiFollowupBatchSize(value, fallback = 2) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(parsed, 25))
}

function aiFollowupGenerationKey(followupContactId, stepNumber) {
  if (!followupContactId || !Number.isInteger(stepNumber) || stepNumber < 1) return null
  return `${followupContactId}:${stepNumber}`
}

function aiFollowupSourceSubmission(previousDrafts = [], contactSubmissions = []) {
  for (const draft of Array.isArray(previousDrafts) ? previousDrafts : []) {
    const submission = draft?.ai_prompt_context?.form_submission
    if (submission) return submission
  }
  const submissions = Array.isArray(contactSubmissions) ? contactSubmissions : []
  return submissions.length > 0 ? submissions[submissions.length - 1] : null
}

module.exports = {
  CampaignClaimConflictError,
  aiFollowupBatchSize,
  aiFollowupGenerationKey,
  aiFollowupSourceSubmission,
  canonicalEmail,
  isCampaignClaimConflictError,
  isSchedulerEnabled,
  keysetPages,
}
