-- Skill Market standalone metadata store
-- Run this (or the migrate script) before first start / ingest.

CREATE TABLE IF NOT EXISTS skill_market_items (
  skill_id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'market',
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  when_to_use TEXT,
  disabled_for_model BOOLEAN NOT NULL DEFAULT false,
  body TEXT NOT NULL,                     -- full SKILL.md content (for GET detail + client rendering)
  resources JSONB NOT NULL DEFAULT '[]',  -- manifest of supporting files
  tos_object_key TEXT NOT NULL,           -- e.g. skills/ad-creative/skill.tar.gz (with prefix applied by storage layer)
  archive_sha256 TEXT NOT NULL,
  archive_size_bytes BIGINT,
  extra_metadata JSONB,                   -- original frontmatter extras (version, metadata.categories, tags, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skill_market_items_name ON skill_market_items (name);
CREATE INDEX IF NOT EXISTS idx_skill_market_items_updated ON skill_market_items (updated_at DESC);

-- Optional: simple health marker row (not required)
-- INSERT INTO skill_market_items ... on conflict do nothing for bootstrap skill if you want one.
