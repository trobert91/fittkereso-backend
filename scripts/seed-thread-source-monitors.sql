-- Seed: Reddit Search ThreadSource for monitor queries
-- Picks 1 random query per day from the pool of 4.
--
-- Run once after the thread_source migration has been applied.

INSERT INTO thread_source (
  id,
  name,
  type,
  enabled,
  "syncInterval",
  "lastRunAt",
  "nextSyncAt",
  config,
  "createdAt",
  "updatedAt"
)
VALUES (
  gen_random_uuid(),
  'Reddit Monitor Searches',
  'reddit-search-query',
  true,
  '1 day',
  NULL,
  NULL,  -- NULL so the scheduler picks it up on the next tick
  '{
    "numberOfQueriesToPick": 1,
    "queries": [
      "best ultrawide monitors",
      "best monitors",
      "best gaming monitors",
      "best monitors for work"
    ]
  }'::jsonb,
  NOW(),
  NOW()
);
