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

module.exports = {
  CampaignClaimConflictError,
  canonicalEmail,
  isCampaignClaimConflictError,
  isSchedulerEnabled,
  keysetPages,
}
