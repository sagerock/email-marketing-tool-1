# General AI Chatbot via Email — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow anyone to email `ai@reply.sagerock.com` and get an AI-powered answer from SageRock's knowledge bases, with automatic contact creation and conversation logging.

**Architecture:** Add a fallback branch in the existing `/api/webhook/inbound-email` handler. When the To address has no `+uuid`, resolve or create the sender as a contact, generate an AI reply using the existing `generateAndSendAiReply()` function, and set the reply-to to `ai+{uuid}@reply.sagerock.com` so future replies flow through the existing UUID path.

**Tech Stack:** Express.js, Supabase, Anthropic Claude API, SendGrid

---

## File Structure

- **Modify:** `api/server.js` — the `/api/webhook/inbound-email` handler (lines 3018-3132). Add a `handleGeneralChatbotEmail()` helper function near the existing `generateAndSendAiReply()` function (line ~3174).

No new files needed. No database changes needed — uses existing `contacts`, `email_conversations`, and `knowledge_bases` tables.

---

### Task 1: Extract the general chatbot handler function

**Files:**
- Modify: `api/server.js:3044-3047` (replace early return with fallback call)
- Modify: `api/server.js:~3170` (add new function before `generateAndSendAiReply`)

- [ ] **Step 1: Add the `handleGeneralChatbotEmail()` function**

Insert this function just before the existing `generateAndSendAiReply` function (before line 3171 in `api/server.js`):

```javascript
/**
 * Handle inbound emails to ai@reply.sagerock.com (no +uuid).
 * Resolves or creates the sender as a contact, generates an AI reply,
 * and routes future replies through the UUID-based handler.
 */
async function handleGeneralChatbotEmail(senderEmail, rawFrom, subject, bodyText, bodyHtml) {
  const clientId = process.env.PUBLIC_SIGNUP_CLIENT_ID
  if (!clientId) {
    console.error('❌ General chatbot: PUBLIC_SIGNUP_CLIENT_ID not configured')
    return
  }

  // Parse display name from From header (e.g., "John Smith <john@example.com>")
  const nameMatch = rawFrom?.match(/^"?([^"<]+)"?\s*</)
  const displayName = nameMatch?.[1]?.trim() || ''
  const nameParts = displayName.split(/\s+/)
  const firstName = nameParts[0] || null
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null

  // Use the plain text body, fall back to stripping HTML
  const messageBody = bodyText?.trim() || bodyHtml?.replace(/<[^>]*>/g, ' ').trim() || ''
  if (!messageBody) {
    console.warn('⚠️ General chatbot: empty message body from:', senderEmail)
    return
  }

  // Strip quoted reply text
  const cleanBody = messageBody
    .split(/\n/)
    .filter(line => !line.startsWith('>'))
    .join('\n')
    .split(/On .+ wrote:/)[0]
    .trim()

  if (!cleanBody) {
    console.warn('⚠️ General chatbot: only quoted text from:', senderEmail)
    return
  }

  // Look up or create contact
  let contact
  const { data: existing } = await supabase
    .from('contacts')
    .select('*')
    .eq('client_id', clientId)
    .eq('email', senderEmail)
    .single()

  if (existing) {
    contact = existing
    console.log(`📇 General chatbot: found existing contact ${senderEmail}`)
  } else {
    const { data: created, error: createError } = await supabase
      .from('contacts')
      .insert({
        client_id: clientId,
        email: senderEmail,
        first_name: firstName,
        last_name: lastName,
        tags: ['ai-chatbot'],
        unsubscribed: false,
      })
      .select()
      .single()

    if (createError) {
      console.error('❌ General chatbot: failed to create contact:', createError.message)
      return
    }
    contact = created
    console.log(`✅ General chatbot: created contact ${senderEmail} with tag ai-chatbot`)
  }

  // Log the inbound message
  await supabase.from('email_conversations').insert({
    client_id: contact.client_id,
    contact_id: contact.id,
    direction: 'inbound',
    subject: subject || '(no subject)',
    body: cleanBody,
    ai_generated: false,
    escalated: false,
  })

  console.log(`📝 General chatbot: logged inbound from ${senderEmail}: "${cleanBody.substring(0, 100)}..."`)

  // Forward inbound message to Sage for visibility
  try {
    const fwdApiKey = process.env.CONTACT_SENDGRID_API_KEY
    if (fwdApiKey) {
      sgMail.setApiKey(fwdApiKey)
      await sgMail.send({
        to: 'sage@sagerock.com',
        from: { email: 'ai@sagerock.com', name: 'SageRock AI Assistant' },
        subject: `📩 ${contact.first_name || senderEmail} emailed the AI chatbot: ${subject || '(no subject)'}`,
        text: `From: ${contact.first_name || ''} ${contact.last_name || ''} (${senderEmail})\n\n${cleanBody}`,
        html: `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">
          <p><strong>From:</strong> ${contact.first_name || ''} ${contact.last_name || ''} (${senderEmail})</p>
          <p><small>New contact: ${!existing ? 'Yes (created with ai-chatbot tag)' : 'No (existing contact)'}</small></p>
          <hr>
          <p>${cleanBody.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>
        </div>`,
      })
    }
  } catch (fwdErr) {
    console.warn('⚠️ General chatbot: failed to forward to Sage:', fwdErr.message)
  }

  // Generate and send AI reply (reuses existing function which handles
  // knowledge base loading, conversation history, Claude, SendGrid, escalation)
  await generateAndSendAiReply(contact, cleanBody, subject)
}
```

- [ ] **Step 2: Replace the early return with the fallback call**

In the `/api/webhook/inbound-email` handler, replace lines 3044-3047:

```javascript
    if (!contactId) {
      console.warn('⚠️ Inbound email: no contact ID in To address:', rawTo)
      return res.status(200).send('OK')
    }
```

With:

```javascript
    if (!contactId) {
      console.log('📨 General chatbot: no +uuid in To address, using general chatbot path')
      // Handle as general chatbot email (async, respond to SendGrid immediately)
      handleGeneralChatbotEmail(senderEmail, rawFrom, subject, bodyText, bodyHtml).catch(err => {
        console.error('❌ General chatbot error:', err)
      })
      return res.status(200).send('OK')
    }
```

- [ ] **Step 3: Verify the system prompt works for general queries**

The existing `generateAndSendAiReply` system prompt (line 3197) says "who signed up for the AI for Business series." This won't be accurate for general chatbot contacts. Update the system prompt at line 3197 to be more generic:

Replace:

```javascript
  const systemPrompt = `You are Sage's AI assistant at SageRock. You're having an email conversation with ${contact.first_name || 'a business owner'} (${contact.email}) who signed up for the AI for Business series.

Your job is to be helpful, answer their questions using the knowledge base, and guide them toward getting started with the course. Be conversational, warm, and genuine — like a helpful colleague, not a chatbot.
```

With:

```javascript
  const systemPrompt = `You are Sage's AI assistant at SageRock. You're having an email conversation with ${contact.first_name || 'someone'} (${contact.email}).

Your job is to be helpful, answer their questions using the knowledge base, and be a genuinely useful resource. Be conversational, warm, and genuine — like a helpful colleague, not a chatbot.
```

- [ ] **Step 4: Test manually by sending an email**

Send a test email from a non-contact email address to `ai@reply.sagerock.com`. Verify:

1. Check Railway logs for `📨 General chatbot: no +uuid in To address` message
2. Check that a new contact was created in Supabase `contacts` table with `ai-chatbot` tag
3. Check that `sage@sagerock.com` received the forwarded inbound email
4. Check that the sender received an AI reply
5. Check that the AI reply has `reply-to: ai+{uuid}@reply.sagerock.com`
6. Check `email_conversations` table for both inbound and outbound records

- [ ] **Step 5: Test reply continuity**

Reply to the AI's response. This should now go through the existing UUID handler (line 3041 regex match). Verify:

1. The reply is handled by the normal UUID path (not the general chatbot path)
2. Conversation history is maintained
3. The AI's response references the prior conversation

- [ ] **Step 6: Test with an existing contact**

Send an email to `ai@reply.sagerock.com` from an email that already exists as a SageRock contact. Verify:

1. No duplicate contact is created
2. The conversation is logged to the existing contact's record
3. The forwarded email to Sage says "No (existing contact)"

- [ ] **Step 7: Commit**

```bash
git add api/server.js
git commit -m "Add general AI chatbot for emails to ai@reply.sagerock.com without +uuid

Emails to the bare address now resolve/create a contact, generate an AI
reply from the knowledge base, and set reply-to with the contact UUID so
future replies flow through the existing conversation system."
```
