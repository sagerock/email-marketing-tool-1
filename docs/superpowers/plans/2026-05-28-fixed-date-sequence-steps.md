# Fixed-Date Sequence Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "send on a specific date" mode to sequence step timing alongside the existing relative-delay mode.

**Architecture:** Extract a pure `computeNextSendTime(step, now)` function, test it in isolation, then wire it into the two scheduling locations in `server.js` and the two enrollment locations. UI adds a radio toggle to each step editor (create and edit flows), plus updates the read-only view display.

**Tech Stack:** Node.js `node:test` for unit tests, Express.js + Supabase backend, React/TypeScript frontend, Tailwind CSS.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/055_add_fixed_date_steps.sql` | **Create** | Adds `timing_anchor` + `fixed_send_at` columns to `sequence_steps` |
| `api/sequence-scheduler.js` | **Create** | Pure function: `computeNextSendTime(step, now) → Date\|null` |
| `api/sequence-scheduler.test.js` | **Create** | Unit tests for the scheduler helper (8 tests) |
| `api/server.js` | **Modify** | Add require; update 4 locations (cron PART 2, dead-code endpoint, `enrollExistingMembers`, cron PART 1) |
| `src/types/index.ts` | **Modify** | Add `timing_anchor` + `fixed_send_at` to `SequenceStep` interface |
| `src/pages/Automations.tsx` | **Modify** | Step editor UI — create flow, edit flow, and read-only view |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/055_add_fixed_date_steps.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Migration 055: add fixed-date timing mode to sequence steps
-- timing_anchor: 'previous_step' (default, existing behavior) | 'fixed_date' (new)
-- fixed_send_at: the specific datetime to send (only used when timing_anchor = 'fixed_date')

ALTER TABLE sequence_steps
  ADD COLUMN timing_anchor TEXT NOT NULL DEFAULT 'previous_step'
    CHECK (timing_anchor IN ('previous_step', 'fixed_date')),
  ADD COLUMN fixed_send_at TIMESTAMPTZ;
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP `apply_migration` tool, or run:
```bash
supabase db push
```

Verify: confirm `sequence_steps` now has `timing_anchor` (default `'previous_step'`) and `fixed_send_at` (nullable). All existing rows should have `timing_anchor = 'previous_step'` — zero behavior change.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/055_add_fixed_date_steps.sql
git commit -m "feat(db): add timing_anchor and fixed_send_at to sequence_steps"
```

---

## Task 2: Scheduler Helper — TDD

**Files:**
- Create: `api/sequence-scheduler.test.js`
- Create: `api/sequence-scheduler.js`

Existing tests in `api/` use Node's built-in `node:test` runner (see `api/crypto-utils.test.js` for the pattern). No external test library needed.

- [ ] **Step 1: Write the failing tests**

Create `api/sequence-scheduler.test.js`:

```javascript
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { computeNextSendTime } = require('./sequence-scheduler.js')

// Fixed reference point for all tests
const NOW = new Date('2026-06-01T12:00:00Z')

test('relative step: schedules at now + delay_days', () => {
  const step = { timing_anchor: 'previous_step', delay_days: 14, delay_hours: 0 }
  const result = computeNextSendTime(step, NOW)
  const expected = new Date(NOW)
  expected.setDate(expected.getDate() + 14)
  assert.deepEqual(result, expected)
})

test('relative step: schedules at now + delay_days + delay_hours', () => {
  const step = { timing_anchor: 'previous_step', delay_days: 2, delay_hours: 6 }
  const result = computeNextSendTime(step, NOW)
  const expected = new Date(NOW)
  expected.setDate(expected.getDate() + 2)
  expected.setHours(expected.getHours() + 6)
  assert.deepEqual(result, expected)
})

test('relative step: missing timing_anchor defaults to relative', () => {
  const step = { delay_days: 7, delay_hours: 0 }
  const result = computeNextSendTime(step, NOW)
  const expected = new Date(NOW)
  expected.setDate(expected.getDate() + 7)
  assert.deepEqual(result, expected)
})

test('fixed_date step: date 7 days out returns that date', () => {
  const fixedSendAt = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const step = { timing_anchor: 'fixed_date', fixed_send_at: fixedSendAt }
  const result = computeNextSendTime(step, NOW)
  assert.deepEqual(result, new Date(fixedSendAt))
})

test('fixed_date step: past date returns null', () => {
  const fixedSendAt = new Date(NOW.getTime() - 60000).toISOString() // 1 minute ago
  const step = { timing_anchor: 'fixed_date', fixed_send_at: fixedSendAt }
  const result = computeNextSendTime(step, NOW)
  assert.equal(result, null)
})

test('fixed_date step: within 3 days (2 days out) returns null', () => {
  const fixedSendAt = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString()
  const step = { timing_anchor: 'fixed_date', fixed_send_at: fixedSendAt }
  const result = computeNextSendTime(step, NOW)
  assert.equal(result, null)
})

test('fixed_date step: exactly 72h out is NOT skipped (strict less-than boundary)', () => {
  const fixedSendAt = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
  const step = { timing_anchor: 'fixed_date', fixed_send_at: fixedSendAt }
  const result = computeNextSendTime(step, NOW)
  assert.deepEqual(result, new Date(fixedSendAt))
})

test('fixed_date step: null fixed_send_at returns null', () => {
  const step = { timing_anchor: 'fixed_date', fixed_send_at: null }
  const result = computeNextSendTime(step, NOW)
  assert.equal(result, null)
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
node --test api/sequence-scheduler.test.js
```

Expected: `Error: Cannot find module './sequence-scheduler.js'`

- [ ] **Step 3: Implement the helper**

Create `api/sequence-scheduler.js`:

```javascript
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
  next.setHours(next.getHours() + (step.delay_hours || 0))
  return next
}

module.exports = { computeNextSendTime }
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
node --test api/sequence-scheduler.test.js
```

Expected: 8 tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add api/sequence-scheduler.js api/sequence-scheduler.test.js
git commit -m "feat: extract computeNextSendTime helper with 8 unit tests"
```

---

## Task 3: Wire Helper into Cron Scheduler

**Files:**
- Modify: `api/server.js`

There are two places in `server.js` with the old `nextSendTime` computation:
1. **Cron PART 2** (~line 7056) — the live scheduling path, runs every minute
2. **Dead-code endpoint** `POST /api/sequences/process` (~line 2779) — never called from frontend; updated for consistency

- [ ] **Step 1: Add require near top of server.js**

After line 20 (`const sgClient = require('@sendgrid/client')`), insert:

```javascript
const { computeNextSendTime } = require('./sequence-scheduler')
```

- [ ] **Step 2: Replace next-step scheduling block in cron PART 2**

Find this block (starting at the `if (nextStep) {` after `// Check if there's a next step`, ~line 7056):

```javascript
          if (nextStep) {
            // Schedule next email (unique constraint prevents duplicates)
            const nextSendTime = new Date()
            nextSendTime.setDate(nextSendTime.getDate() + (nextStep.delay_days || 0))
            nextSendTime.setHours(nextSendTime.getHours() + (nextStep.delay_hours || 0))

            await supabase.from('scheduled_emails').upsert({
              enrollment_id: enrollment.id,
              step_id: nextStep.id,
              contact_id: contact.id,
              scheduled_for: nextSendTime.toISOString(),
              status: 'pending',
            }, {
              onConflict: 'enrollment_id,step_id',
              ignoreDuplicates: true
            })

            await supabase
              .from('sequence_enrollments')
              .update({
                current_step: step.step_order,
                last_email_sent_at: new Date().toISOString(),
                next_email_scheduled_at: nextSendTime.toISOString(),
              })
              .eq('id', enrollment.id)
          } else {
            // Sequence completed
            await supabase
              .from('sequence_enrollments')
              .update({
                current_step: step.step_order,
                status: 'completed',
                completed_at: new Date().toISOString(),
                last_email_sent_at: new Date().toISOString(),
                next_email_scheduled_at: null,
              })
              .eq('id', enrollment.id)

            // Update sequence completed count
            await supabase
              .from('email_sequences')
              .update({ total_completed: sequence.total_completed + 1 })
              .eq('id', sequence.id)
          }
```

Replace with:

```javascript
          if (nextStep) {
            const scheduledFor = computeNextSendTime(nextStep, now)

            if (scheduledFor === null) {
              // Fixed-date step skipped (past or within 3-day minimum gap)
              console.log(`⏭️ Skipping fixed-date step ${nextStep.id} for enrollment ${enrollment.id}`)

              // Advance chain: look for the step after the skipped one
              const { data: stepAfterSkipped } = await supabase
                .from('sequence_steps')
                .select('*')
                .eq('sequence_id', sequence.id)
                .eq('step_order', nextStep.step_order + 1)
                .single()

              if (stepAfterSkipped) {
                const nextNextSendTime = computeNextSendTime(stepAfterSkipped, now)
                if (nextNextSendTime !== null) {
                  await supabase.from('scheduled_emails').upsert({
                    enrollment_id: enrollment.id,
                    step_id: stepAfterSkipped.id,
                    contact_id: contact.id,
                    scheduled_for: nextNextSendTime.toISOString(),
                    status: 'pending',
                  }, { onConflict: 'enrollment_id,step_id', ignoreDuplicates: true })

                  await supabase
                    .from('sequence_enrollments')
                    .update({
                      current_step: step.step_order,
                      last_email_sent_at: new Date().toISOString(),
                      next_email_scheduled_at: nextNextSendTime.toISOString(),
                    })
                    .eq('id', enrollment.id)
                } else {
                  // Step after skipped is also skipped — complete enrollment
                  await supabase
                    .from('sequence_enrollments')
                    .update({
                      current_step: step.step_order,
                      status: 'completed',
                      completed_at: new Date().toISOString(),
                      last_email_sent_at: new Date().toISOString(),
                      next_email_scheduled_at: null,
                    })
                    .eq('id', enrollment.id)
                  await supabase
                    .from('email_sequences')
                    .update({ total_completed: sequence.total_completed + 1 })
                    .eq('id', sequence.id)
                }
              } else {
                // No step after skipped — complete enrollment
                await supabase
                  .from('sequence_enrollments')
                  .update({
                    current_step: step.step_order,
                    status: 'completed',
                    completed_at: new Date().toISOString(),
                    last_email_sent_at: new Date().toISOString(),
                    next_email_scheduled_at: null,
                  })
                  .eq('id', enrollment.id)
                await supabase
                  .from('email_sequences')
                  .update({ total_completed: sequence.total_completed + 1 })
                  .eq('id', sequence.id)
              }
            } else {
              // Normal scheduling (relative or future fixed-date)
              await supabase.from('scheduled_emails').upsert({
                enrollment_id: enrollment.id,
                step_id: nextStep.id,
                contact_id: contact.id,
                scheduled_for: scheduledFor.toISOString(),
                status: 'pending',
              }, { onConflict: 'enrollment_id,step_id', ignoreDuplicates: true })

              await supabase
                .from('sequence_enrollments')
                .update({
                  current_step: step.step_order,
                  last_email_sent_at: new Date().toISOString(),
                  next_email_scheduled_at: scheduledFor.toISOString(),
                })
                .eq('id', enrollment.id)
            }
          } else {
            // Sequence completed (no next step at all)
            await supabase
              .from('sequence_enrollments')
              .update({
                current_step: step.step_order,
                status: 'completed',
                completed_at: new Date().toISOString(),
                last_email_sent_at: new Date().toISOString(),
                next_email_scheduled_at: null,
              })
              .eq('id', enrollment.id)

            await supabase
              .from('email_sequences')
              .update({ total_completed: sequence.total_completed + 1 })
              .eq('id', sequence.id)
          }
```

Note: `now` in this context is the Date object already in scope at the top of the cron handler.

- [ ] **Step 3: Update the dead-code endpoint (~line 2779)**

Find inside `POST /api/sequences/process` (lines ~2779–2803):

```javascript
        if (nextStep) {
          // Schedule next email (unique constraint prevents duplicates)
          const nextSendTime = new Date()
          nextSendTime.setDate(nextSendTime.getDate() + (nextStep.delay_days || 0))
          nextSendTime.setHours(nextSendTime.getHours() + (nextStep.delay_hours || 0))

          await supabase.from('scheduled_emails').upsert({
            enrollment_id: enrollment.id,
            step_id: nextStep.id,
            contact_id: contact.id,
            scheduled_for: nextSendTime.toISOString(),
            status: 'pending',
          }, {
            onConflict: 'enrollment_id,step_id',
            ignoreDuplicates: true
          })

          await supabase
            .from('sequence_enrollments')
            .update({
              current_step: step.step_order,
              last_email_sent_at: new Date().toISOString(),
              next_email_scheduled_at: nextSendTime.toISOString(),
            })
            .eq('id', enrollment.id)
        } else {
```

Replace with:

```javascript
        if (nextStep) {
          const scheduledFor = computeNextSendTime(nextStep, new Date())

          if (scheduledFor !== null) {
            await supabase.from('scheduled_emails').upsert({
              enrollment_id: enrollment.id,
              step_id: nextStep.id,
              contact_id: contact.id,
              scheduled_for: scheduledFor.toISOString(),
              status: 'pending',
            }, {
              onConflict: 'enrollment_id,step_id',
              ignoreDuplicates: true
            })

            await supabase
              .from('sequence_enrollments')
              .update({
                current_step: step.step_order,
                last_email_sent_at: new Date().toISOString(),
                next_email_scheduled_at: scheduledFor.toISOString(),
              })
              .eq('id', enrollment.id)
          }
          // null: fixed-date step skipped — enrollment stays active, no scheduled_email created
        } else {
```

- [ ] **Step 4: Commit**

```bash
git add api/server.js
git commit -m "feat: wire computeNextSendTime into cron scheduler"
```

---

## Task 4: Update Enrollment Functions

**Files:**
- Modify: `api/server.js` (~lines 4890–4918, ~lines 6810–6853)

Both enrollment paths currently hard-code `scheduled_for = now` for the first step. When step 1 has `timing_anchor = 'fixed_date'`, it should schedule at `fixed_send_at` instead.

- [ ] **Step 1: Update `enrollExistingMembers` (~line 4890)**

Find:

```javascript
    const now = new Date().toISOString()

    // Create enrollments and get IDs back atomically (prevents race condition)
    const enrollmentsToCreate = subscribedContactIds.map(contactId => ({
      sequence_id: sequenceId,
      contact_id: contactId,
      status: 'active',
      current_step: 0,
      enrolled_at: now,
      next_email_scheduled_at: now, // Send first email immediately
    }))
```

Replace with:

```javascript
    const now = new Date().toISOString()
    const firstStepScheduledFor =
      firstStep.timing_anchor === 'fixed_date' && firstStep.fixed_send_at
        ? firstStep.fixed_send_at
        : now

    // Create enrollments and get IDs back atomically (prevents race condition)
    const enrollmentsToCreate = subscribedContactIds.map(contactId => ({
      sequence_id: sequenceId,
      contact_id: contactId,
      status: 'active',
      current_step: 0,
      enrolled_at: now,
      next_email_scheduled_at: firstStepScheduledFor,
    }))
```

Find (a few lines lower):

```javascript
      const scheduledEmailsToCreate = newEnrollments.map(enrollment => ({
        enrollment_id: enrollment.id,
        step_id: firstStep.id,
        contact_id: enrollment.contact_id,
        scheduled_for: now,
        status: 'pending',
        attempts: 0,
      }))
```

Replace `scheduled_for: now` with `scheduled_for: firstStepScheduledFor`:

```javascript
      const scheduledEmailsToCreate = newEnrollments.map(enrollment => ({
        enrollment_id: enrollment.id,
        step_id: firstStep.id,
        contact_id: enrollment.contact_id,
        scheduled_for: firstStepScheduledFor,
        status: 'pending',
        attempts: 0,
      }))
```

- [ ] **Step 2: Update cron PART 1 tag-triggered enrollment (~line 6810)**

Find:

```javascript
          const now = new Date()

          // Create enrollments and get IDs back atomically (prevents race condition)
          const enrollments = newContactIds.map(contactId => ({
            sequence_id: sequence.id,
            contact_id: contactId,
            status: 'active',
            current_step: 0,
            next_email_scheduled_at: now.toISOString(),
          }))
```

Replace with:

```javascript
          const now = new Date()
          const firstStepScheduledFor =
            firstStep.timing_anchor === 'fixed_date' && firstStep.fixed_send_at
              ? new Date(firstStep.fixed_send_at)
              : now

          // Create enrollments and get IDs back atomically (prevents race condition)
          const enrollments = newContactIds.map(contactId => ({
            sequence_id: sequence.id,
            contact_id: contactId,
            status: 'active',
            current_step: 0,
            next_email_scheduled_at: firstStepScheduledFor.toISOString(),
          }))
```

Find (a few lines lower inside the same block):

```javascript
            const scheduledEmails = enrollmentsToSchedule.map(enrollment => ({
              enrollment_id: enrollment.id,
              step_id: firstStep.id,
              contact_id: enrollment.contact_id,
              scheduled_for: now.toISOString(),
              status: 'pending',
            }))
```

Replace `scheduled_for: now.toISOString()` with `scheduled_for: firstStepScheduledFor.toISOString()`:

```javascript
            const scheduledEmails = enrollmentsToSchedule.map(enrollment => ({
              enrollment_id: enrollment.id,
              step_id: firstStep.id,
              contact_id: enrollment.contact_id,
              scheduled_for: firstStepScheduledFor.toISOString(),
              status: 'pending',
            }))
```

- [ ] **Step 3: Commit**

```bash
git add api/server.js
git commit -m "feat: use fixed_send_at when scheduling first step at enrollment"
```

---

## Task 5: TypeScript Type + UI

**Files:**
- Modify: `src/types/index.ts` (line 171)
- Modify: `src/pages/Automations.tsx` (multiple sections)

There are three components in `Automations.tsx` that touch step timing:
1. **Create-sequence modal** — uses local `sequenceSteps` state, saves via `stepsToInsert` in `handleSubmit`
2. **Edit-sequence modal** — writes directly to Supabase on every field change via `updateStep`/`updateStepMultiple`
3. **View-sequence modal** — read-only display of step timing (lines 1569–1573)

- [ ] **Step 1: Update `SequenceStep` interface**

In `src/types/index.ts`, find lines 171–186:

```typescript
export interface SequenceStep {
  id: string
  sequence_id: string
  step_order: number
  subject: string
  template_id?: string
  html_content?: string
  delay_days: number
  delay_hours: number
  send_time?: string
  sent_count: number
  open_count: number
  click_count: number
  created_at: string
  updated_at: string
}
```

Replace with:

```typescript
export interface SequenceStep {
  id: string
  sequence_id: string
  step_order: number
  subject: string
  template_id?: string
  html_content?: string
  delay_days: number
  delay_hours: number
  send_time?: string
  timing_anchor: 'previous_step' | 'fixed_date'
  fixed_send_at: string | null
  sent_count: number
  open_count: number
  click_count: number
  created_at: string
  updated_at: string
}
```

- [ ] **Step 2: Add `toLocalDatetimeInput` helper to Automations.tsx**

After the import block at the top of `src/pages/Automations.tsx`, add:

```typescript
// Converts a UTC ISO string to a local datetime-local input value (YYYY-MM-DDTHH:MM).
// The datetime-local input interprets its value as local time, so we must convert from UTC.
function toLocalDatetimeInput(isoString: string): string {
  const d = new Date(isoString)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
```

- [ ] **Step 3: Update create-sequence initial step state**

Find line 347–348:

```typescript
  const [sequenceSteps, setSequenceSteps] = useState<Partial<SequenceStep>[]>([
    { step_order: 1, subject: '', delay_days: 0, delay_hours: 0 }
  ])
```

Replace with:

```typescript
  const [sequenceSteps, setSequenceSteps] = useState<Partial<SequenceStep>[]>([
    { step_order: 1, subject: '', delay_days: 0, delay_hours: 0, timing_anchor: 'previous_step', fixed_send_at: null }
  ])
```

- [ ] **Step 4: Update create-sequence `addStep`**

Find lines 389–398:

```typescript
  const addStep = () => {
    setSequenceSteps([
      ...sequenceSteps,
      {
        step_order: sequenceSteps.length + 1,
        subject: '',
        delay_days: 1,
        delay_hours: 0
      }
    ])
  }
```

Replace with:

```typescript
  const addStep = () => {
    setSequenceSteps([
      ...sequenceSteps,
      {
        step_order: sequenceSteps.length + 1,
        subject: '',
        delay_days: 1,
        delay_hours: 0,
        timing_anchor: 'previous_step',
        fixed_send_at: null,
      }
    ])
  }
```

- [ ] **Step 5: Update `stepsToInsert` in create-sequence `handleSubmit`**

Find the `stepsToInsert` map (around line 465) and add the two new fields:

```typescript
      const stepsToInsert = sequenceSteps.map(s => ({
        sequence_id: sequence.id,
        step_order: s.step_order,
        subject: s.subject,
        template_id: s.template_id || null,
        delay_days: s.delay_days || 0,
        delay_hours: s.delay_hours || 0,
        timing_anchor: s.timing_anchor || 'previous_step',
        fixed_send_at: s.fixed_send_at || null,
```

(Add `timing_anchor` and `fixed_send_at` after `delay_hours`; leave all other fields unchanged.)

- [ ] **Step 6: Replace timing UI in create-sequence step editor**

Find lines 686–706 (the `Wait X days X hours` block inside the `sequenceSteps.map`):

```tsx
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-gray-600">Wait</span>
                          <input
                            type="number"
                            min="0"
                            className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                            value={stepData.delay_days || 0}
                            onChange={(e) => updateStep(index, 'delay_days', parseInt(e.target.value) || 0)}
                          />
                          <span className="text-sm text-gray-600">days</span>
                          <input
                            type="number"
                            min="0"
                            max="23"
                            className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                            value={stepData.delay_hours || 0}
                            onChange={(e) => updateStep(index, 'delay_hours', parseInt(e.target.value) || 0)}
                          />
                          <span className="text-sm text-gray-600">
                            {index === 0 ? 'after enrollment' : 'after previous step'}
                          </span>
                        </div>
```

Replace with:

```tsx
                        <div className="space-y-2">
                          <div className="flex items-center gap-4">
                            <label className="flex items-center gap-2 text-sm cursor-pointer">
                              <input
                                type="radio"
                                name={`timing-${index}`}
                                checked={stepData.timing_anchor !== 'fixed_date'}
                                onChange={() => updateStep(index, 'timing_anchor', 'previous_step')}
                              />
                              After a delay
                            </label>
                            <label className="flex items-center gap-2 text-sm cursor-pointer">
                              <input
                                type="radio"
                                name={`timing-${index}`}
                                checked={stepData.timing_anchor === 'fixed_date'}
                                onChange={() => updateStep(index, 'timing_anchor', 'fixed_date')}
                              />
                              On a specific date
                            </label>
                          </div>
                          {stepData.timing_anchor === 'fixed_date' ? (
                            <input
                              type="datetime-local"
                              className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                              value={stepData.fixed_send_at ? toLocalDatetimeInput(stepData.fixed_send_at) : ''}
                              onChange={(e) => updateStep(index, 'fixed_send_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
                            />
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-gray-600">Wait</span>
                              <input
                                type="number"
                                min="0"
                                className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                                value={stepData.delay_days || 0}
                                onChange={(e) => updateStep(index, 'delay_days', parseInt(e.target.value) || 0)}
                              />
                              <span className="text-sm text-gray-600">days</span>
                              <input
                                type="number"
                                min="0"
                                max="23"
                                className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                                value={stepData.delay_hours || 0}
                                onChange={(e) => updateStep(index, 'delay_hours', parseInt(e.target.value) || 0)}
                              />
                              <span className="text-sm text-gray-600">
                                {index === 0 ? 'after enrollment' : 'after previous step'}
                              </span>
                            </div>
                          )}
                        </div>
```

- [ ] **Step 7: Replace timing UI in edit-sequence step editor**

Find lines 1145–1166 (the `Wait X days X hours` block inside the edit-sequence `steps.map`):

```tsx
                        <div className="flex items-center gap-2 pb-2 border-b">
                          <Clock className="h-4 w-4 text-gray-400" />
                          <span className="text-sm text-gray-600">Wait</span>
                          <input
                            type="number"
                            min="0"
                            className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                            value={step.delay_days}
                            onChange={(e) => updateStep(step.id, 'delay_days', parseInt(e.target.value) || 0)}
                          />
                          <span className="text-sm text-gray-600">days</span>
                          <input
                            type="number"
                            min="0"
                            max="23"
                            className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                            value={step.delay_hours}
                            onChange={(e) => updateStep(step.id, 'delay_hours', parseInt(e.target.value) || 0)}
                          />
                          <span className="text-sm text-gray-600">
                            {index === 0 ? 'hours after enrollment' : 'hours after previous'}
                          </span>
                        </div>
```

Replace with:

```tsx
                        <div className="space-y-2 pb-2 border-b">
                          <div className="flex items-center gap-4">
                            <label className="flex items-center gap-2 text-sm cursor-pointer">
                              <input
                                type="radio"
                                name={`timing-${step.id}`}
                                checked={step.timing_anchor !== 'fixed_date'}
                                onChange={() => updateStep(step.id, 'timing_anchor', 'previous_step')}
                              />
                              After a delay
                            </label>
                            <label className="flex items-center gap-2 text-sm cursor-pointer">
                              <input
                                type="radio"
                                name={`timing-${step.id}`}
                                checked={step.timing_anchor === 'fixed_date'}
                                onChange={() => updateStep(step.id, 'timing_anchor', 'fixed_date')}
                              />
                              On a specific date
                            </label>
                          </div>
                          {step.timing_anchor === 'fixed_date' ? (
                            <input
                              type="datetime-local"
                              className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                              value={step.fixed_send_at ? toLocalDatetimeInput(step.fixed_send_at) : ''}
                              onChange={(e) => updateStep(step.id, 'fixed_send_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
                            />
                          ) : (
                            <div className="flex items-center gap-2">
                              <Clock className="h-4 w-4 text-gray-400" />
                              <span className="text-sm text-gray-600">Wait</span>
                              <input
                                type="number"
                                min="0"
                                className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                                value={step.delay_days}
                                onChange={(e) => updateStep(step.id, 'delay_days', parseInt(e.target.value) || 0)}
                              />
                              <span className="text-sm text-gray-600">days</span>
                              <input
                                type="number"
                                min="0"
                                max="23"
                                className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                                value={step.delay_hours}
                                onChange={(e) => updateStep(step.id, 'delay_hours', parseInt(e.target.value) || 0)}
                              />
                              <span className="text-sm text-gray-600">
                                {index === 0 ? 'hours after enrollment' : 'hours after previous'}
                              </span>
                            </div>
                          )}
                        </div>
```

- [ ] **Step 8: Update `addStep` in edit-sequence modal (~line 927)**

Find:

```typescript
      const { data, error } = await supabase
        .from('sequence_steps')
        .insert({
          sequence_id: sequence.id,
          step_order: newStepOrder,
          subject: `Email ${newStepOrder}`,
          delay_days: newStepOrder === 1 ? 0 : 1,
          delay_hours: 0,
        })
```

Replace with:

```typescript
      const { data, error } = await supabase
        .from('sequence_steps')
        .insert({
          sequence_id: sequence.id,
          step_order: newStepOrder,
          subject: `Email ${newStepOrder}`,
          delay_days: newStepOrder === 1 ? 0 : 1,
          delay_hours: 0,
          timing_anchor: 'previous_step',
          fixed_send_at: null,
        })
```

- [ ] **Step 9: Update read-only step timing display in ViewSequenceModal**

Find lines 1569–1573:

```tsx
                        <p className="text-xs text-gray-500">
                          {step.delay_days === 0 && step.delay_hours === 0
                            ? index === 0 ? 'Sends immediately' : 'Sends right after previous'
                            : index === 0
                              ? `${step.delay_days}d ${step.delay_hours}h after enrollment`
                              : `${step.delay_days}d ${step.delay_hours}h after previous`}
                        </p>
```

Replace with:

```tsx
                        <p className="text-xs text-gray-500">
                          {step.timing_anchor === 'fixed_date'
                            ? step.fixed_send_at
                              ? `Sends ${new Date(step.fixed_send_at).toLocaleString()}`
                              : 'Fixed date (not set)'
                            : step.delay_days === 0 && step.delay_hours === 0
                              ? index === 0 ? 'Sends immediately' : 'Sends right after previous'
                              : index === 0
                                ? `${step.delay_days}d ${step.delay_hours}h after enrollment`
                                : `${step.delay_days}d ${step.delay_hours}h after previous`}
                        </p>
```

- [ ] **Step 10: TypeScript build check**

```bash
npm run build
```

Expected: clean build with no TypeScript errors. If errors appear about `timing_anchor` or `fixed_send_at` being possibly `undefined`, the fix is to add `|| 'previous_step'` or `|| null` guards at the point of use.

- [ ] **Step 11: Commit**

```bash
git add src/types/index.ts src/pages/Automations.tsx
git commit -m "feat: add fixed-date timing mode to sequence step editor UI"
```

---

## Self-Check After All Tasks

After completing all tasks, manually verify in the running app:

1. **Create a new sequence** — add a step, switch it to "On a specific date," pick a date 2+ weeks out, save. Confirm the step saves and reloads showing the correct date in the datepicker.

2. **Edit an existing sequence** — open the edit modal, switch a step to "On a specific date," change the date. Confirm it saves immediately (the edit flow writes directly to Supabase).

3. **Switch back** — from "On a specific date" back to "After a delay." Confirm delay inputs reappear and save correctly.

4. **View modal** — open the ViewSequenceModal for a sequence with a fixed-date step. Confirm it shows the formatted date string instead of `0d 0h after previous`.

5. **Run unit tests** — `node --test api/sequence-scheduler.test.js` — all 8 pass.

> **Note on spec tests 9–10** ("enrollment with fixed-date step 1"): these require Supabase to be live and aren't unit-testable in isolation. They're covered by manual verification items 1–2 above.
