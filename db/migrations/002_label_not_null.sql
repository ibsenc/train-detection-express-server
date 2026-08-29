-- Migration 002: Make `label` NOT NULL, replacing NULL with 'unknown'
--
-- NULL previously meant "unreviewed". 'unknown' is now the canonical value for that state.
-- After this migration, label is guaranteed non-null on every row.
--
-- Run locally:
--   psql -U camille -d train_detection -f db/migrations/002_label_not_null.sql
--
-- Run on prod (Neon):
--   psql "$TRAIN_DATABASE_URL_PROD" -f db/migrations/002_label_not_null.sql

BEGIN;

UPDATE detections SET label = 'unknown' WHERE label IS NULL;

ALTER TABLE detections ALTER COLUMN label SET DEFAULT 'unknown';
ALTER TABLE detections ALTER COLUMN label SET NOT NULL;

COMMIT;
