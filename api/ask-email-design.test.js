const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  authorizedBearer,
  validateDraftRequest,
  normalizeGeneratedDesign,
  createAskEmailDesignHandler,
} = require('./ask-email-design')


function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}


test('bearer authentication uses an exact secret match', () => {
  assert.equal(authorizedBearer('Bearer shared-secret', 'shared-secret'), true)
  assert.equal(authorizedBearer('Bearer shared-secrex', 'shared-secret'), false)
  assert.equal(authorizedBearer('shared-secret', 'shared-secret'), false)
  assert.equal(authorizedBearer('Bearer anything', ''), false)
})


test('draft request is bounded and requires idempotency', () => {
  assert.deepEqual(
    validateDraftRequest({ brief: '  Make a welcome email  ', name: ' Welcome ' }, 'mail-1'),
    {
      brief: 'Make a welcome email',
      name: 'Welcome',
      referenceTemplateIds: [],
      requestKey: 'mail-1',
    }
  )
  assert.throws(
    () => validateDraftRequest({ brief: 'Make it' }, ''),
    /Idempotency-Key/
  )
  assert.throws(
    () => validateDraftRequest({
      brief: 'Make it', referenceTemplateIds: ['not-a-uuid'],
    }, 'mail-1'),
    /at most two UUIDs/
  )
})


test('generated design requires compliance tags and rejects active content', () => {
  const valid = {
    name: 'Welcome',
    subject: 'Hello',
    preview_text: 'A short preview',
    html_content: '<!DOCTYPE html><html><body><a href="{{unsubscribe_url}}">Unsubscribe</a>{{mailing_address}}</body></html>',
  }
  assert.equal(normalizeGeneratedDesign(valid).subject, 'Hello')
  assert.throws(
    () => normalizeGeneratedDesign({
      ...valid, html_content: '<!DOCTYPE html><html><body>No footer</body></html>',
    }),
    /compliance tags/
  )
  assert.throws(
    () => normalizeGeneratedDesign({
      ...valid,
      html_content: '<!DOCTYPE html><html><body><script>alert(1)</script><a href="{{unsubscribe_url}}">x</a>{{mailing_address}}</body></html>',
    }),
    /unsafe HTML/
  )
})


test('handler refuses unauthenticated requests before generation', async () => {
  let called = false
  const handler = createAskEmailDesignHandler({
    supabase: {}, apiKey: 'secret', clientId: 'fixed-client', baseUrl: 'https://mail.sagerock.com',
    generateDesign: async () => { called = true },
  })
  const res = fakeResponse()
  await handler({ headers: {}, body: { brief: 'Make it' } }, res)
  assert.equal(res.statusCode, 401)
  assert.equal(called, false)
})


test('handler always uses the configured client and returns a draft link', async () => {
  let captured
  const handler = createAskEmailDesignHandler({
    supabase: { marker: true },
    apiKey: 'secret',
    clientId: 'fixed-sagerock-client',
    baseUrl: 'https://mail.sagerock.com/',
    anthropicFactory: () => ({ messages: {} }),
    generateDesign: async input => {
      captured = input
      return {
        created: true,
        status: 'design_draft',
        id: 'template-1',
        review_url: 'https://mail.sagerock.com/email-builder?templateId=template-1',
      }
    },
  })
  const req = {
    headers: {
      authorization: 'Bearer secret',
      'idempotency-key': 'message-1',
    },
    body: {
      brief: 'Design a welcome email',
      name: 'Welcome',
      clientId: 'attacker-controlled-client',
    },
  }
  const res = fakeResponse()
  await handler(req, res)

  assert.equal(res.statusCode, 201)
  assert.equal(captured.clientId, 'fixed-sagerock-client')
  assert.equal(captured.baseUrl, 'https://mail.sagerock.com')
  assert.equal(res.body.status, 'design_draft')
})
