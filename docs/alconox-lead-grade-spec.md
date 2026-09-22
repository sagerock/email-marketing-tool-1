# Alconox lead grade — one-page spec (draft for Alconox review)

Written 2026-09-22 by Jax. Status: proposal, not built. Numbers below come from a
simulation against Alconox's live data on 2026-09-22.

## What it is

Every Alconox contact gets a letter grade, A to D, recomputed nightly from what they have
actually done: bought, entered the sales pipeline, replied, chatted, downloaded, clicked,
opened. Recent actions count fully; old ones fade. Next to the grade is a plain-English
"why" so nobody has to trust a letter on its own. Once a week, a short list of who moved
(new A's, big jumps, and people going cold) goes to the same reviewers who get the chat
follow-ups. The grade is a signal for humans, not an automation trigger.

## Points and fading

Each action earns points that halve every "half-life" days. Score = sum of faded points.

| Action | Points | Half-life | Cap | Source |
|---|---|---|---|---|
| Placed an order | 40 per order | 180 days | 60 | WooCommerce sync |
| Open Salesforce opportunity | 35 flat while open | none | 35 | Salesforce |
| Closed-won opportunity | 25 | 365 days | 25 | Salesforce |
| Replied to an AI follow-up / campaign | 25 | 60 days | 25 | reply relay |
| Used the website AI chat | 20 per chat | 60 days | 40 | Salesforce Case |
| Downloaded a member resource | 15 per download | 90 days | 30 | Salesforce Prospect Activity |
| Submitted a form (sample, Ask Alconox) | 15 per form | 90 days | 30 | Gravity Forms webhook |
| Clicked an email link | 6 per click | 45 days | 24 | SendGrid (bot clicks already filtered) |
| Opened an email | 2 per open | 45 days | 10 | SendGrid |

Worked example: an order 90 days ago (40 × 0.5 = 20) plus a download last week (15 × 0.95 =
14) plus two clicks this month (12 × 0.7 = 8) = 42 points = grade B.

## Grades

| Grade | Score | Meaning | People today (simulated) |
|---|---|---|---|
| A | 45+ | Hot: buying, in pipeline, or several recent touches | ~40 |
| B | 20–44 | Warm: a real action in the last few months | ~680 |
| C | 8–19 | Aware: some email engagement, nothing deeper | ~2,600 |
| D | under 8 | Quiet: on the list, not engaging | ~26,500 |
| none | — | Unsubscribed or hard-bounced; never graded | ~60,000 |

Thresholds are the knob to turn. Raising A to 60 shrinks it to about 6 people; lowering it
to 40 grows it to about 66. The ungraded group shrinks by roughly 16,600 when the false
hard-bounce flags from the summer cold-IP sends are cleared before the October Scoop.

## What the weekly signal reports

- Entered A this week, with the why.
- Jumped two or more grades (for example D to B) this week.
- Was A or B and has now gone quiet: no action in 90 days, grade fell to D.
- Counts by grade, so the shape of the list is visible over time.

Sent Monday morning to the chat-follow-up reviewers. Also shown as a column and filter on
the Engagement page, so "show me all A's in Biotech" is a click.

## Rules

- Unsubscribed and hard-bounced contacts get no grade and never appear on the list.
- alconox.com addresses and contacts tagged "Alconox Internal" are excluded.
- The grade never sends email on its own and never writes to Salesforce until Alconox says
  so and Cheyenne confirms the field and format.
- Every grade stores its inputs, so any letter can be explained and audited.

## Known limits

- Reply detection covers replies that reach our relay (cleaning@ and campaign replies).
  Replies handled entirely inside Alconox's inbox are invisible to us.
- Opens are a weak signal (Apple Mail Privacy opens everything), hence the small weight
  and low cap.
- Chats and downloads only started arriving on 2026-09-16 and 2026-09-19, so those
  columns are thin for now.
- The simulation used per-contact totals for opens and clicks with one recency date; the
  real build fades each event individually, so the exact counts will shift a little.

## Open questions for Alconox

1. Do these weights match how Alconox's salespeople think about a hot lead?
2. Should a customer with a recent order be graded at all, or handled by account managers?
3. Who should receive the weekly list, and is Monday the right day?
4. Should the grade go into Salesforce, and if so which field?
