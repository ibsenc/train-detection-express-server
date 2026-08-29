# Train Detection API

| Environment | Base URL |
|-------------|----------|
| Local | `http://localhost:3000` |
| Lambda / API Gateway | See `API_BASE_URL` in your environment config |

---

## Hello

### `GET /hello`

Basic liveness check.

**Response `200`**
```json
{ "message": "Hello World" }
```

---

## Health

### `GET /health`

Check server and database connectivity.

**Response `200`**
```json
{
  "status": "ok",
  "db": "connected",
  "timestamp": "2026-05-18T14:00:00.000Z"
}
```

**Response `503`** — database unreachable
```json
{ "status": "error", "db": "unreachable" }
```

---

## Alerts

### `GET /test-alert`

Sends a test iMessage to `ALERT_PHONE_NUMBER` to verify alerts are working.

Note: Only works for local running server on macOS.

**Response `200`**
```json
{ "message": "Test alert sent to +15551234567" }
```

**Response `400`** — `ALERT_PHONE_NUMBER` not configured
```json
{ "error": "ALERT_PHONE_NUMBER is not set in .env" }
```

---

## Detections

### `POST /api/detections`

Ingest a new sound event from a sensor node.

**Content-Type:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `decibels` | number | Yes | Measured sound level (0–200 dB) |
| `duration_seconds` | number | Yes | How long the event lasted |
| `timestamp` | string (ISO 8601) | No | Defaults to server time if omitted |
| `source` | string | No | Sensor label / identifier |
| `id` | string (UUID) | Yes | Client-generated UUID — used as the S3 filename and stored for cross-referencing |
| `audio_file` | file (.wav) | No | Raw audio recording (max 6 MB) |

Events are automatically flagged `is_suspected_train: true` when `decibels >= TRAIN_MIN_DECIBELS` and `duration_seconds >= TRAIN_MIN_DURATION_SECONDS`. `label` is always `unknown` on creation and must be set manually via `PATCH`. (Local only) If a phone number is configured, an iMessage alert is sent for suspected trains.

**Response `201`**
```json
{
  "id": "b54fbac7-d760-4bdb-a0ff-4bfd34997bd6",
  "timestamp": "2026-05-18T14:00:00.000Z",
  "decibels": 104.5,
  "duration_seconds": 18.3,
  "source": "pi-north",
  "audio_url": "https://your-bucket.s3.us-east-1.amazonaws.com/detections/2026-05-18/...",
  "is_suspected_train": true,
  "label": "unknown",
  "created_at": "2026-05-18T14:00:00.123Z"
}
```

**Response `502`** — S3 upload failed
```json
{ "error": "Audio upload to S3 failed" }
```

**Example (curl)**
```bash
curl -X POST http://localhost:3000/api/detections \
  -F "audio_file=@recording.wav" \
  -F "id=b54fbac7-d760-4bdb-a0ff-4bfd34997bd6" \
  -F "decibels=104.5" \
  -F "duration_seconds=18.3" \
  -F "source=pi-north"
```

---

### `GET /api/detections`

Query detection events with optional filters. Returns newest-first.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `start` | string (ISO 8601) | Range start, inclusive |
| `end` | string (ISO 8601) | Range end, inclusive |
| `min_db` | number | Minimum decibel threshold |
| `confirmed_only` | boolean | `true` to return only confirmed trains (`train` or `train_horn`). Default `false` |
| `label` | string | Filter by exact label: `train`, `train_horn`, `non_train`, or `unknown` |
| `source` | string | Filter by sensor label |
| `limit` | number | Max results to return. Default `100`, max `1000` |
| `offset` | number | Pagination offset. Default `0` |

**Response `200`**
```json
{
  "total": 284,
  "limit": 100,
  "offset": 0,
  "data": [
    {
      "id": 42,
      "timestamp": "2026-05-18T14:00:00.000Z",
      "decibels": 104.5,
      "duration_seconds": 18.3,
      "source": "pi-north",
      "audio_url": "https://your-bucket.s3.us-east-1.amazonaws.com/detections/2026-05-18/...",
      "is_suspected_train": true,
      "label": "train",
      "created_at": "2026-05-18T14:00:00.123Z"
    }
  ]
}
```

---

### `GET /api/detections/latest`

Returns the most recent detection.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `label` | string | Filter by exact label: `train`, `train_horn`, `non_train`, or `unknown`. Overrides `confirmed_only` when provided |
| `confirmed_only` | boolean | `false` to include all events. Default `true` |

**Response `200`** — returns a single detection object (see above)

**Response `404`**
```json
{ "message": "No detections found" }
```

---

### `GET /api/detections/stats`

Aggregate statistics for the dashboard.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `source` | string | Filter stats to a specific sensor |
| `start` | string (ISO 8601) | Range start, inclusive. Defaults to all time |
| `end` | string (ISO 8601) | Range end, inclusive. Defaults to all time |

**Response `200`**
```json
{
  "total_events": 1042,
  "suspected_trains": 94,
  "confirmed_trains": 87,
  "confirmed_train_horns": 12,
  "confirmed_false_positives": 5,
  "unreviewed_suspected": 2,
  "suspected_last_24h": 4,
  "suspected_last_7d": 31,
  "last_suspected_at": "2026-05-18T11:32:00.000Z",
  "last_confirmed_at": "2026-05-17T09:14:00.000Z",
  "avg_decibels": "101.34",
  "max_decibels": "112.00",
  "avg_duration_seconds": "14.72"
}
```

---

### `GET /api/detections/:id`

Fetch a single detection by ID.

**Response `200`** — returns a single detection object

**Response `404`**
```json
{ "error": "Detection not found" }
```

---

### `GET /api/detections/:id/audio-url`

Generate a presigned S3 URL for streaming or downloading the audio file associated with a detection. The URL expires after **7 days**.

**Response `200`**
```json
{
  "url": "https://your-bucket.s3.us-east-1.amazonaws.com/detections/2026-05-18/...?X-Amz-Signature=...",
  "expires_in": 604800
}
```

**Response `404`** — detection not found, or detection has no audio file
```json
{ "error": "No audio file for this detection" }
```

---

### `PATCH /api/detections/:id`

Manually set the `label` on a detection to review it.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | string | Yes | `train`, `train_horn`, `non_train`, or `unknown` (reset to unreviewed) |

**Response `200`** — returns the updated detection object

**Response `404`**
```json
{ "error": "Detection not found" }
```

---

### `DELETE /api/detections/:id`

Permanently delete a detection record. If the detection has an associated audio file, it is also deleted from S3. If the S3 deletion fails, the database record is still removed and the error is logged server-side (orphaned audio files are tolerated).

**Response `204`** — no content

**Response `404`**
```json
{ "error": "Detection not found" }
```

---

## Error responses

All endpoints return errors in this shape:

```json
{ "error": "Human-readable error message" }
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request — invalid or missing parameters |
| `404` | Resource not found |
| `500` | Internal server error |
| `502` | S3 upload failed |
| `503` | Service unavailable (database unreachable) |
