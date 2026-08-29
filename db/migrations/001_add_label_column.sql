-- Migration 001: Add `label` enum column alongside `is_confirmed_train`
--
-- Phase 1 of 3 — safe to run while old server code is still live.
-- Adds a nullable column (no table rewrite) then backfills from the boolean.
-- Phase 2: update server.js to read/write `label`
-- Phase 3: drop `is_confirmed_train` (separate migration after Phase 2 is stable)
--
-- Run locally:
--   psql -U camille -d train_detection -f db/migrations/001_add_label_column.sql
--
-- Run on prod (Neon):
--   psql "<DATABASE_URL>" -f db/migrations/001_add_label_column.sql

BEGIN;

-- 1. Enum type
CREATE TYPE detection_label AS ENUM ('train', 'train_horn', 'non_train', 'unknown');

-- 2. Add nullable column (instant — no table rewrite in Postgres)
ALTER TABLE detections ADD COLUMN label detection_label DEFAULT NULL;

-- 3. Backfill from boolean column
UPDATE detections SET label = 'train'     WHERE is_confirmed_train = true;
UPDATE detections SET label = 'non_train' WHERE is_confirmed_train = false;
-- NULLs stay NULL (unreviewed)

-- 4. Index for the new column (mirrors the old confirmed_train index)
CREATE INDEX idx_detections_label ON detections (label, timestamp DESC)
  WHERE label IS NOT NULL;

COMMIT;
