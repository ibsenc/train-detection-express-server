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
DB_USER=postgres
DB_PASSWORD=your_password_here
DB_SSL=false

# Optional: iMessage alerts (macOS - local testing only)
ALERT_PHONE_NUMBER=+1xxxxxxxxxx

# AWS S3 (for audio storage)
AWS_REGION=us-west-2
AWS_S3_BUCKET=your_bucket_name
```

For Lambda function, only these values are needed in environment variables:
```
AWS_S3_BUCKET=your-bucket-name
DATABASE_URL=postgresql://neondb_owner...
```

### 3. Initialize the database

```bash
psql -U postgres -d train_detection -f db/schema.sql
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

1. **Install production dependencies** (skip if `node_modules` is already up to date):
   ```bash
   npm install --omit=dev
   ```

2. **Create a deployment zip** from the project root:
   ```bash
   zip -r deployment.zip . --exclude "*.git*" --exclude ".env" --exclude "*.zip" --exclude "*.sql" --exclude "local_dump*" --exclude "remote_dump*"
   ```

3. **Upload to Lambda** via the AWS CLI (replace `your-function-name` with your actual function name):
   ```bash
   aws lambda update-function-code \
     --function-name your-function-name \
     --zip-file fileb://deployment.zip
   ```

   Or upload manually in the Lambda console: **Code** tab → **Upload from** → **.zip file**, then click the **Deploy** button.

4. **Verify the deploy** — the console will show the new **Last modified** timestamp, and you can use the **Test** tab to run a health check event.

> `deployment.zip` is gitignored and should not be committed.

---

## Database

### Dump

**Local database:**
```bash
pg_dump -U postgres train_detection > local_dump.sql
```

**Remote database (via `DATABASE_URL`):**

Use `--no-owner --no-privileges` to strip out hosted-Postgres-specific roles (e.g. Neon's `neondb_owner`) that don't exist locally:
```bash
pg_dump "$DATABASE_URL" --no-owner --no-privileges > remote_dump_05_21_2026.sql
```

### Restore

Drop and recreate the local database first to avoid conflicts with existing schema or data, then restore with local or remote dump:
```bash
dropdb -U postgres train_detection
createdb -U postgres train_detection
psql -U postgres -d train_detection < local_dump.sql
```
