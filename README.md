# Train Detection Server

Express API server for ingesting sound detection events from Raspberry Pi sensor nodes, storing them in PostgreSQL, and uploading audio recordings to S3. Runs locally or as an AWS Lambda function via `serverless-http`.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root, used for local testing:

```env
# Server
PORT=3000

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=train_detection
DB_USER=camille
DB_PASSWORD=your_password_here
DB_SSL=false

# Optional: iMessage alerts (macOS - local testing only)
ALERT_PHONE_NUMBER=+1xxxxxxxxxx

# Detection thresholds (optional, these are the defaults)
TRAIN_MIN_DECIBELS=65
TRAIN_MIN_DURATION_SECONDS=1

# AWS S3 (for audio storage)
AWS_REGION=us-west-2
AWS_S3_BUCKET=your_bucket_name
```

For Lambda function, these values are needed as environment variables:
```
AWS_S3_BUCKET=your-bucket-name
DATABASE_URL=postgresql://neondb_owner...
TRAIN_MIN_DECIBELS=65
TRAIN_MIN_DURATION_SECONDS=1
```

### 3. Initialize the database

```bash
psql -U camille -d train_detection -f db/schema.sql
```

### 4. Start the server

```bash
npm start
```

The server runs on port `3000` by default (`PORT` env var to override).

---

## API

See [API.md](./API.md) for full endpoint documentation.

---

## AWS Lambda deployment

This server exports a `handler` for use with AWS Lambda + API Gateway via `serverless-http`.

### Binary media types

The `POST /api/detections` endpoint accepts `multipart/form-data` uploads containing `.wav` files. API Gateway must be configured to treat `multipart/form-data` as a binary media type, otherwise the audio data will be corrupted in transit.

### Deploying changes to Lambda

Run the deploy script:
```bash
npm run deploy
```

This does the following in sequence:
1. **`npm install --omit=dev`** — ensures production dependencies are up to date
2. **Creates a timestamped zip** (e.g. `deployment_07_31_2026_14_30_00.zip`) from the project root, excluding `.git`, `.env`, existing zips, and SQL dump files
3. **Uploads the zip to Lambda** via the AWS CLI targeting the `train-detection-express` function

After deploying, verify in the Lambda console — the **Code** tab will show an updated **Last modified** timestamp. Use the **Test** tab to run a health check event.

> Deployment zips are covered by the `*.zip` gitignore pattern and should not be committed.

---

## Database

> **Local Postgres user is `camille`** (macOS default — no password required). `DB_USER=camille` in `.env`.

### Dump

**Local database:**
```bash
pg_dump -U camille train_detection > local_dump_MM_DD_YYYY.sql
```

**Remote database (via `TRAIN_DATABASE_URL_PROD`):**

Use `--no-owner --no-privileges` to strip out hosted-Postgres-specific roles (e.g. Neon's `neondb_owner`) that don't exist locally:
```bash
pg_dump "$TRAIN_DATABASE_URL_PROD" --no-owner --no-privileges > remote_dump_MM_DD_YYYY.sql
```

### Restore

Terminate any connections to the db, drop and recreate the local database (to avoid schema conflicts), then restore with local or remote dump:
```bash
psql -U camille -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'train_detection' AND pid <> pg_backend_pid();"
dropdb -U camille train_detection
createdb -U camille train_detection
psql -U camille -d train_detection < remote_dump_MM_DD_YYYY.sql
```

> If the database doesn't exist yet, skip the terminate/drop steps and run `createdb` + restore directly.
