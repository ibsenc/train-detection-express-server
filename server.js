import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { execFile } from 'node:child_process';
import multer from 'multer';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import serverless from 'serverless-http';
import pool from './db.js';

const s3Config = { region: process.env.AWS_REGION || 'us-west-2' };

// When running locally, supply credentials explicitly (not available in env).
// In Lambda, credentials are provided automatically via the execution role.
if (process.env.TRAIN_DETECTION_AWS_ACCESS_KEY_ID) {
  s3Config.credentials = {
    accessKeyId: process.env.TRAIN_DETECTION_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.TRAIN_DETECTION_AWS_SECRET_ACCESS_KEY,
  };
}

const s3 = new S3Client(s3Config);

// Accept only .wav files, up to 6 MB - due to Lambda's 6 MB sync payload limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'audio/wav' || file.mimetype === 'audio/x-wav') {
      cb(null, true);
    } else {
      cb(new Error('Only .wav audio files are accepted'));
    }
  },
});

async function uploadToS3(buffer, key) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'audio/wav',
  }));
  return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${key}`;
}

function sendMessage(phoneNumber, message) {
  // Escape backslashes and double-quotes so they don't break the AppleScript string
  const safe = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile(
    'osascript',
    [
      '-e', 'tell application "Messages"',
      '-e', `send "${safe}" to buddy "${phoneNumber}" of (first service whose service type = iMessage)`,
      '-e', 'end tell',
    ],
    (err) => {
      if (err) console.error('iMessage alert failed:', err.message);
      else console.log(`[${new Date().toISOString()}] iMessage sent to ${phoneNumber}`);
    }
  );
}

const app = express();
const PORT = process.env.PORT || 3000;

// Regex for standard UUID v4 format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Thresholds for flagging a detection as a suspected train ---
const TRAIN_MIN_DECIBELS = parseFloat(process.env.TRAIN_MIN_DECIBELS) || 65;
const TRAIN_MIN_DURATION_SECONDS = parseFloat(process.env.TRAIN_MIN_DURATION_SECONDS) || 1;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Hello World
// ---------------------------------------------------------------------------
app.get('/hello', (req, res) => {
  res.json({ message: 'Hello World' });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/detections
// Ingest a new sound event from the Raspberry Pi sensor.
//
// Body (multipart/form-data):
//   audio_file        {file}    optional  — raw .wav recording (max 6 MB)
//   id                {string}  required  — client-generated UUID for cross-referencing
//   decibels          {number}  required  — measured sound level in dB
//   duration_seconds  {number}  required  — how long the event lasted
//   timestamp         {string}  optional  — ISO 8601; defaults to now()
//   source            {string}  optional  — sensor label / identifier
// ---------------------------------------------------------------------------
app.post('/api/detections', upload.single('audio_file'), async (req, res) => {
  const { decibels, duration_seconds, timestamp, source, id } = req.body;

  if (!id) {
    return res.status(400).json({ error: '`id` is required' });
  }
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: '`id` must be a valid UUID (e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)' });
  }

  if (decibels === undefined || decibels === null) {
    return res.status(400).json({ error: '`decibels` is required' });
  }
  if (duration_seconds === undefined || duration_seconds === null) {
    return res.status(400).json({ error: '`duration_seconds` is required' });
  }

  const db = parseFloat(decibels);
  const dur = parseFloat(duration_seconds);

  if (isNaN(db) || db < 0 || db > 200) {
    return res.status(400).json({ error: '`decibels` must be a number between 0 and 200' });
  }
  if (isNaN(dur) || dur < 0) {
    return res.status(400).json({ error: '`duration_seconds` must be a non-negative number' });
  }

  const ts = timestamp ? new Date(timestamp) : new Date();
  if (isNaN(ts.getTime())) {
    return res.status(400).json({ error: '`timestamp` must be a valid ISO 8601 date string' });
  }

  // Upload audio to S3 if provided
  let audio_url = null;
  if (req.file) {
    const datePrefix = ts.toISOString().slice(0, 10); // YYYY-MM-DD
    const key = `detections/${datePrefix}/${id}.wav`;
    try {
      audio_url = await uploadToS3(req.file.buffer, key);
    } catch (err) {
      console.error('S3 upload failed:', err);
      return res.status(502).json({ error: 'Audio upload to S3 failed' });
    }
  }

  // Auto-flag likely trains based on dB level and duration
  const is_suspected_train = db >= TRAIN_MIN_DECIBELS && dur >= TRAIN_MIN_DURATION_SECONDS;
  // is_confirmed_train starts NULL (unreviewed); set manually via PATCH /api/detections/:id

  try {
    const result = await pool.query(
      `INSERT INTO detections (id, timestamp, decibels, duration_seconds, source, audio_url, is_suspected_train, is_confirmed_train)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
       RETURNING *`,
      [id, ts.toISOString(), db, dur, source ?? null, audio_url ?? null, is_suspected_train]
    );
    const detection = result.rows[0];
    console.log(
      `[${new Date().toISOString()}] POST /api/detections — id=${detection.id} db=${db} dur=${dur}s source=${source ?? 'none'} suspected=${is_suspected_train}`
    );

    if (is_suspected_train && process.env.ALERT_PHONE_NUMBER) {
      const time = new Date(detection.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      sendMessage(
        process.env.ALERT_PHONE_NUMBER,
        `🚂 Train detected at ${time} — ${db} dB for ${dur}s (source: ${source ?? 'unknown'})`
      );
    }

    res.status(201).json(detection);
  } catch (err) {
    console.error('POST /api/detections error:', err);
    res.status(500).json({ error: 'Failed to store detection' });
  }
});

// ---------------------------------------------------------------------------
// GET /test-alert
// Sends a test iMessage to ALERT_PHONE_NUMBER to verify alerts are working.
// ---------------------------------------------------------------------------
app.get('/test-alert', (req, res) => {
  if (!process.env.ALERT_PHONE_NUMBER) {
    return res.status(400).json({ error: 'ALERT_PHONE_NUMBER is not set in .env' });
  }
  sendMessage(process.env.ALERT_PHONE_NUMBER, '🚂 Test alert from Train Detection Server — alerts are working!');
  res.json({ message: `Test alert sent to ${process.env.ALERT_PHONE_NUMBER}` });
});

// ---------------------------------------------------------------------------
// GET /api/detections/latest
// Returns the most recent confirmed train detection.
//
// Query params:
//   label           {string}   — exact label to match (train|train_horn|non_train|unknown); overrides confirmed_only
//   confirmed_only  {boolean}  default true — set to false to include all events
// ---------------------------------------------------------------------------
app.get('/api/detections/latest', async (req, res) => {
  const { confirmed_only, label } = req.query;
  if (label !== undefined && !VALID_LABELS.has(label)) {
    return res.status(400).json({ error: 'Invalid `label` value' });
  }
  const confirmedOnly = confirmed_only !== 'false';

  const [clause, queryParams] = label !== undefined
    ? [`WHERE label = $1`, [label]]
    : [`WHERE ($1 = false OR label IN ('train', 'train_horn'))`, [confirmedOnly]];

  try {
    const result = await pool.query(
      `SELECT * FROM detections ${clause} ORDER BY timestamp DESC LIMIT 1`,
      queryParams
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No detections found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /api/detections/latest error:', err);
    res.status(500).json({ error: 'Failed to fetch latest detection' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/detections
// Query detections with optional filters. Returns newest-first.
//
// Query params:
//   start           {string}  ISO 8601 — range start (inclusive)
//   end             {string}  ISO 8601 — range end (inclusive)
//   min_db          {number}  — minimum decibel threshold
//   confirmed_only  {boolean} default false — only return confirmed trains (train or train_horn)
//   label           {string}  — filter by exact label (train|train_horn|non_train|unknown)
//   source          {string}  — filter by sensor label
//   limit           {number}  default 100, max 1000
//   offset          {number}  default 0
// ---------------------------------------------------------------------------
app.get('/api/detections', async (req, res) => {
  const { start, end, min_db, confirmed_only, label, source, limit = 100, offset = 0 } = req.query;

  const parsedLimit = Math.min(parseInt(limit) || 100, 1000);
  const parsedOffset = parseInt(offset) || 0;

  const conditions = [];
  const params = [];

  if (start) {
    const d = new Date(start);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid `start` date' });
    params.push(d.toISOString());
    conditions.push(`timestamp >= $${params.length}`);
  }
  if (end) {
    const d = new Date(end);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid `end` date' });
    params.push(d.toISOString());
    conditions.push(`timestamp <= $${params.length}`);
  }
  if (min_db !== undefined) {
    const db = parseFloat(min_db);
    if (isNaN(db)) return res.status(400).json({ error: 'Invalid `min_db` value' });
    params.push(db);
    conditions.push(`decibels >= $${params.length}`);
  }
  if (confirmed_only === 'true') {
    conditions.push("label IN ('train', 'train_horn')");
  }
  if (label !== undefined) {
    if (!VALID_LABELS.has(label)) return res.status(400).json({ error: 'Invalid `label` value' });
    params.push(label);
    conditions.push(`label = $${params.length}`);
  }
  if (source) {
    params.push(source);
    conditions.push(`source = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(parsedLimit);
  params.push(parsedOffset);

  try {
    const result = await pool.query(
      `SELECT * FROM detections
       ${where}
       ORDER BY timestamp DESC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM detections ${where}`,
      params.slice(0, params.length - 2)
    );

    res.json({
      total: parseInt(countResult.rows[0].count),
      limit: parsedLimit,
      offset: parsedOffset,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /api/detections error:', err);
    res.status(500).json({ error: 'Failed to fetch detections' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/detections/stats
// Aggregate statistics useful for the dashboard.
//
// Query params:
//   source  {string}  — filter by sensor label
//   start   {string}  ISO 8601 — range start (inclusive); defaults to all time
//   end     {string}  ISO 8601 — range end (inclusive); defaults to all time
// ---------------------------------------------------------------------------
app.get('/api/detections/stats', async (req, res) => {
  const { source, start, end } = req.query;
  const params = [];
  const conditions = ['1=1'];

  if (source) {
    params.push(source);
    conditions.push(`source = $${params.length}`);
  }

  let startDate = null;
  let endDate = null;

  if (start) {
    startDate = new Date(start);
    if (isNaN(startDate.getTime())) return res.status(400).json({ error: 'Invalid `start` date' });
  }
  if (end) {
    endDate = new Date(end);
    if (isNaN(endDate.getTime())) return res.status(400).json({ error: 'Invalid `end` date' });
  }
  if (startDate && endDate && startDate > endDate) {
    return res.status(400).json({ error: '`start` must be before or equal to `end`' });
  }

  if (startDate) {
    params.push(startDate.toISOString());
    conditions.push(`timestamp >= $${params.length}`);
  }
  if (endDate) {
    params.push(endDate.toISOString());
    conditions.push(`timestamp <= $${params.length}`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const result = await pool.query(
      `SELECT
         COUNT(*)                                                               AS total_events,
         COUNT(*) FILTER (WHERE is_suspected_train = true)                     AS suspected_trains,
         COUNT(*) FILTER (WHERE label = 'train')                              AS confirmed_trains,
         COUNT(*) FILTER (WHERE label = 'train_horn')                          AS confirmed_train_horns,
         COUNT(*) FILTER (WHERE label = 'non_train')                           AS confirmed_false_positives,
         COUNT(*) FILTER (WHERE label = 'unknown'
                            AND is_suspected_train = true)                     AS unreviewed_suspected,
         -- TODO: remove suspected_last_24h/7d once frontend uses start/end params to compute these windows itself
         COUNT(*) FILTER (WHERE timestamp >= NOW() - INTERVAL '24 hours'
                            AND is_suspected_train = true)                     AS suspected_last_24h,
         COUNT(*) FILTER (WHERE timestamp >= NOW() - INTERVAL '7 days'
                            AND is_suspected_train = true)                     AS suspected_last_7d,
         MAX(timestamp) FILTER (WHERE is_suspected_train = true)              AS last_suspected_at,
         MAX(timestamp) FILTER (WHERE label IN ('train', 'train_horn'))       AS last_confirmed_at,
         ROUND(AVG(decibels)::numeric, 2)                                     AS avg_decibels,
         ROUND(MAX(decibels)::numeric, 2)                                     AS max_decibels,
         ROUND(AVG(duration_seconds)::numeric, 2)                             AS avg_duration_seconds
       FROM detections
       ${where}`,
      params
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /api/detections/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/detections/:id
// Fetch a single detection by its ID.
// ---------------------------------------------------------------------------
app.get('/api/detections/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid detection ID' });

  try {
    const result = await pool.query('SELECT * FROM detections WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Detection not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /api/detections/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch detection' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/detections/:id/audio-url
// Returns a presigned S3 URL for streaming or downloading the audio file.
// The URL expires after 7 days (604800 seconds).
// ---------------------------------------------------------------------------
const AUDIO_URL_EXPIRY_SECONDS = 604800; // 7 days

app.get('/api/detections/:id/audio-url', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid detection ID' });

  try {
    const result = await pool.query('SELECT audio_url FROM detections WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Detection not found' });

    const { audio_url } = result.rows[0];
    if (!audio_url) return res.status(404).json({ error: 'No audio file for this detection' });

    // Extract the S3 key from the stored URL
    const key = new URL(audio_url).pathname.slice(1);

    const command = new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: key });
    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: AUDIO_URL_EXPIRY_SECONDS });

    res.json({ url: presignedUrl, expires_in: AUDIO_URL_EXPIRY_SECONDS });
  } catch (err) {
    console.error('GET /api/detections/:id/audio-url error:', err);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/detections/:id
// Manually set the label on a detection (e.g. from the UI).
//
// Body (JSON):
//   label  {string}  required — train|train_horn|non_train|unknown
// ---------------------------------------------------------------------------
const VALID_LABELS = new Set(['train', 'train_horn', 'non_train', 'unknown']);

app.patch('/api/detections/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid detection ID' });

  const { label } = req.body;
  if (!VALID_LABELS.has(label)) {
    return res.status(400).json({ error: '`label` must be train, train_horn, non_train, or unknown' });
  }

  // keep is_confirmed_train in sync during transition (Phase 3 will drop it)
  const legacyValue = (label === 'train' || label === 'train_horn') ? true
                    : label === 'non_train' ? false
                    : null; // 'unknown' maps to null

  try {
    const result = await pool.query(
      'UPDATE detections SET label = $1, is_confirmed_train = $2 WHERE id = $3 RETURNING *',
      [label, legacyValue, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Detection not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /api/detections/:id error:', err);
    res.status(500).json({ error: 'Failed to update detection' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/detections/:id
// Permanently remove a detection record.
// ---------------------------------------------------------------------------
app.delete('/api/detections/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid detection ID' });

  try {
    const result = await pool.query(
      'DELETE FROM detections WHERE id = $1 RETURNING audio_url',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Detection not found' });
    }

    const { audio_url } = result.rows[0];
    if (audio_url) {
      const key = new URL(audio_url).pathname.slice(1);
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: key }));
      } catch (s3Err) {
        console.error('DELETE /api/detections/:id — S3 deletion failed (orphaned file):', s3Err);
      }
    }

    console.log(`[${new Date().toISOString()}] DELETE /api/detections/:id — id=${req.params.id} audio_deleted=${!!audio_url}`);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/detections/:id error:', err);
    res.status(500).json({ error: 'Failed to delete detection' });
  }
});

// ---------------------------------------------------------------------------
// Serverless handler export (AWS Lambda / etc.)

// Setting the base path tells the wrapper to ignore it before routing
export const handler = serverless(app, {
  basePath: '/train-detection-express'
});

// Local dev: start HTTP server when not running in a serverless environment
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, () => {
    console.log(`Train Detection Server running on port ${PORT}`);
  });
}
