-- Train Detection Database Schema
-- Run once to initialize the database:
--   psql -U postgres -d train_detection -f db/schema.sql

CREATE TABLE IF NOT EXISTS detections (
    id                  UUID PRIMARY KEY,
    timestamp           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decibels            NUMERIC(6, 2) NOT NULL,
    duration_seconds    NUMERIC(7, 2) NOT NULL,
    source              VARCHAR(255),
    audio_url           TEXT,
    -- Auto-flagged by threshold: decibels >= 96 AND duration >= 10s
    is_suspected_train  BOOLEAN NOT NULL DEFAULT FALSE,
    -- Manually set via API: NULL = unreviewed, true = confirmed train, false = false positive
    is_confirmed_train  BOOLEAN DEFAULT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Speed up time-range queries (most common dashboard query)
CREATE INDEX IF NOT EXISTS idx_detections_timestamp       ON detections (timestamp DESC);
-- Speed up filtering to confirmed trains only
CREATE INDEX IF NOT EXISTS idx_detections_confirmed_train ON detections (is_confirmed_train, timestamp DESC)
  WHERE is_confirmed_train IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_detections_suspected_train ON detections (timestamp DESC)
  WHERE is_suspected_train = true;
-- Speed up per-sensor queries
CREATE INDEX IF NOT EXISTS idx_detections_source          ON detections (source, timestamp DESC);
