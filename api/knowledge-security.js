// Service-role queries must carry their own tenant boundary.
function scopeKnowledgeQuery(query, adminUser) {
  if (adminUser?.role === 'super_admin' || adminUser?.role === 'admin') return query
  if (adminUser?.role === 'client_admin' && adminUser.client_id) {
    return query.eq('client_id', adminUser.client_id)
  }
  const error = new Error('Access denied')
  error.status = 403
  throw error
}

async function findOwnedKnowledge(supabase, id, adminUser) {
  const { data, error } = await scopeKnowledgeQuery(
    supabase.from('knowledge_bases').select('id, client_id').eq('id', id), adminUser,
  ).maybeSingle()
  if (error) throw error
  if (!data) {
    const missing = new Error('Knowledge base not found')
    missing.status = 404
    throw missing
  }
  return data
}

module.exports = { scopeKnowledgeQuery, findOwnedKnowledge }
