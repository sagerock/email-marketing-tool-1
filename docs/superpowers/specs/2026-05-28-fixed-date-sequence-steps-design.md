# Fixed-Date Sequence Steps

**Date:** 2026-05-28
**Status:** Approved, ready for implementation

## Problem

Automation sequence steps only support relative delays ("send X days/hours after enrollment or previous step"). This makes it impossible to schedule a step for a specific calendar date, such as "send 2 days before the program starts."

The immediate use case is CfA Renewal 2026: 19 sequences (one per program), each with a "touch 3" email that should fire a fixed number of days before the program's start date. All in-person programs start June 28; all online programs start July 6. Touch 3 dates are June 26 and July 4 respectively — only two unique dates across 19 sequences.

## Solution

Add a "send on a specific date" mode to the step editor. Steps can be either:
- **Relative** (`timing_anchor = 'previous_step'`): current behavior, send X days/hours after enrollment or previous step
- **Fixed date** (`timing_anchor = 'fixed_date'`): send at a specific datetime, regardless of when the contact enrolled

## Schema — Migration 055

```sql
ALTER TABLE sequence_steps
  ADD COLUMN timing_anchor TEXT NOT NULL DEFAULT 'previous_step'
    CHECK (timing_anchor IN ('previous_step', 'fixed_date')),
  ADD COLUMN fixed_send_at TIMESTAMPTZ;
```

- All existing rows receive `timing_anchor = 'previous_step'` automatically — zero behavior change for live sequences.
- `fixed_send_at` is null for relative steps. For fixed-date steps it must be non-null; this is enforced in the UI (not at the DB level to avoid migration complexity).
- No changes to `sequence_enrollments`, `scheduled_emails`, or any other table.

## Enrollment Flow

**Affected code:** tag-triggered auto-enrollment (cron PART 1, `server.js` ~line 6810) and `enrollExistingMembers` endpoint (~line 4899).

Both currently schedule step 1 with `scheduled_for = now`. Updated logic:

```javascript
const firstStepScheduledFor =
  firstStep.timing_anchor === 'fixed_date' && firstStep.fixed_send_at
    ? firstStep.fixed_send_at  // use the fixed date
    : now                       // existing behavior: send immediately
```

For CfA, step 1 is always "send immediately" so this branch is not exercised. It is included for correctness if a future sequence starts with a fixed-date step.

## Scheduler Logic

**Affected code:** cron PART 2 (`server.js` ~line 7056) — the live path. The `/api/sequences/process` endpoint (~line 2781) has duplicate logic and receives the same update for consistency, though it is never called.

After step N sends, when computing `scheduled_for` for step N+1:

```javascript
let scheduledFor

if (nextStep.timing_anchor === 'fixed_date') {
  const fixedAt = new Date(nextStep.fixed_send_at)
  const minGapCutoff = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000) // now + 72h

  if (!nextStep.fixed_send_at || fixedAt < minGapCutoff) {
    // Skip: date is past OR within 3-day minimum gap from now
    console.log(`⏭️ Skipping fixed-date step ${nextStep.id} for enrollment ${enrollment.id} — too close or past`)
    // Advance the chain: look up the step after this one and schedule it,
    // or mark enrollment completed if this was the last step.
    skipAndAdvance()
    continue
  }

  scheduledFor = fixedAt
} else {
  // Existing relative-delay logic (unchanged)
  const nextSendTime = new Date(now)
  nextSendTime.setDate(nextSendTime.getDate() + (nextStep.delay_days || 0))
  nextSendTime.setHours(nextSendTime.getHours() + (nextStep.delay_hours || 0))
  scheduledFor = nextSendTime
}
```

### Skip behavior

When a fixed-date step is skipped:
1. Look up the step after the skipped step (step_order + 1).
2. If a subsequent step exists, schedule it using its own `timing_anchor` logic (relative from now, or fixed date).
3. If no subsequent step exists, mark the enrollment as `completed`.

This prevents contacts from falling into limbo and keeps the chain progressing naturally.

### 3-day minimum gap rationale

The same emails are sent up to 3 times across the sequence. Sending touches 2 and 3 on the same day or back-to-back days (e.g., Tuesday/Wednesday) is a poor experience. The 3-day guard prevents this without requiring any per-step configuration. The threshold is hardcoded; it can be made configurable via a `min_gap_days` column in a future migration if needed.

## Edge Cases

| Scenario | Behavior |
|---|---|
| Fixed-date step, `fixed_send_at` ≥ 3 days in the future | Schedule normally at `fixed_send_at` |
| Fixed-date step, `fixed_send_at` in the past | Skip, advance chain |
| Fixed-date step, `fixed_send_at` < 3 days away | Skip, advance chain |
| `fixed_send_at` is null on a fixed-date step | Treated as past, skipped |
| Skipped step was the last step | Mark enrollment completed |
| Skipped step has steps after it | Schedule next step from now |
| Step 1 has `timing_anchor = 'fixed_date'` | First scheduled_email uses `fixed_send_at` |
| `enrollExistingMembers` with fixed-date step 1 | Same — uses `fixed_send_at` |
| Contact enrolls after fixed date has passed | Step is skipped when it reaches the scheduler |

## UI — Automations.tsx Step Editor

The step configuration card gains a timing mode selector. Current behavior (delay inputs) becomes the default "After a delay" option. A new "On a specific date" option reveals a date+time picker and hides the delay inputs.

```
Timing
  ● After a delay      [ 14 ] days  [ 0 ] hours  after previous step
  ○ On a specific date   [ 2026-06-26 ]  at  [ 09:00 ]
```

Implementation notes:
- Two radio options; "After a delay" is the default for new steps.
- Switching modes toggles which inputs are shown; values are preserved in state if you switch back.
- "On a specific date" uses `<input type="datetime-local">` — the browser renders it in the user's local timezone. The value is converted to UTC (ISO string) before saving to Postgres.
- The `Step` TypeScript type gains `timing_anchor: 'previous_step' | 'fixed_date'` and `fixed_send_at: string | null`.
- `updateStep()` handles changes to both new fields.
- No changes to the sequence-level configuration UI.

## Test Coverage

Tests to write (TDD — tests first):

1. **Relative step schedules correctly** — `timing_anchor = 'previous_step'`, computes `now + delay_days + delay_hours` (regression)
2. **Fixed-date step, future date** — `fixed_send_at` 7 days out, `scheduled_for` equals `fixed_send_at`
3. **Fixed-date step, past date** — `fixed_send_at` yesterday, step is skipped
4. **Fixed-date step, within 3 days** — `fixed_send_at` 2 days out, step is skipped
5. **Fixed-date step, exactly 3 days** — boundary: `fixed_send_at` exactly 72h out, step schedules normally (`<` is strict, so `fixedAt === cutoff` is not skipped)
6. **Skipped fixed-date step, last step** — enrollment marked completed
7. **Skipped fixed-date step, has next step** — next step is scheduled from now
8. **Null fixed_send_at** — treated as past, skipped
9. **Enrollment with fixed-date step 1** — `scheduled_for` = `fixed_send_at`, not `now`
10. **enrollExistingMembers with fixed-date step 1** — same as above

## Files Touched

| File | Change |
|---|---|
| `supabase/migrations/055_add_fixed_date_steps.sql` | New migration |
| `api/server.js` | Cron PART 1 enrollment, cron PART 2 scheduler, dead-code endpoint |
| `src/pages/Automations.tsx` | Step editor UI, Step type |
| `api/sequence-scheduler.js` (new) | Extracted helper: `computeNextSendTime(nextStep, now)` — pure function, testable in isolation |
| `api/sequence-scheduler.test.js` (new) | Unit tests for the extracted helper, using `node:test` (same pattern as `crypto-utils.test.js`) |

## Out of Scope

- Configurable minimum gap per step (`min_gap_days` column) — hardcode 3 days for now
- Timezone selector — browser local time is sufficient; store as UTC
- "X days before a date" relative-to-program mode — replaced by simpler fixed-date approach
- Changes to campaign sending, analytics, or other sequence triggers
