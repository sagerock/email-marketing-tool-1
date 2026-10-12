-- Migration 111: RSS auto-notifications get an audience and an approval mode.
--
-- Migration 094 sends every new feed item to ALL of a client's active contacts, which is
-- right for a single-purpose client (Sage Lewis) and wrong for a client whose contact list
-- is mixed (SageRock: leads, clients, event contacts). These columns let a client scope the
-- watcher to one tagged list and hold each post as a draft campaign for approval.
--
-- All three are optional and default to the old behavior, so existing clients are unchanged.

ALTER TABLE clients
  -- Only contacts carrying ANY of these tags receive the post. NULL/empty = all contacts.
  ADD COLUMN IF NOT EXISTS rss_filter_tags text[],
  -- 'send' = email automatically (the original behavior). 'draft' = create the campaign
  -- as a draft and leave it for a person to review and send from the Campaigns screen.
  ADD COLUMN IF NOT EXISTS rss_mode text NOT NULL DEFAULT 'send'
    CHECK (rss_mode IN ('send', 'draft')),
  -- 'card' = the original boxed layout. 'plain' = a short personal-looking note.
  ADD COLUMN IF NOT EXISTS rss_style text NOT NULL DEFAULT 'card'
    CHECK (rss_style IN ('card', 'plain'));
