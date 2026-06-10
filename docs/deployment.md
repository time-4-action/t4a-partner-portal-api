# Deployment Guide

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP server port |
| `NODE_ENV` | No | -- | `production` or `development` |
| `DATA_PATH` | No | `cwd()` | Base path for `.env` and data files (Docker: `/data`) |
| **PNV** | | | |
| `PNV_BASE_URL` | Yes | -- | Base URL of the PNV admin panel |
| `PNV_EXPORT_PRODUCTS_URL` | Yes | -- | PNV endpoint that triggers the CSV export |
| `PNV_USER` | Yes | -- | PNV login username |
| `PNV_PASS` | Yes | -- | PNV login password (hashed SHA1 internally) |
| `PNV_GROUP` | Yes | -- | PNV group ID |
| `PNV_USER_ID` | Yes | -- | PNV user ID |
| **Metakocka** | | | |
| `METAKOCKA_ID` | Yes | -- | Metakocka account ID |
| `METAKOCKA_KEY` | Yes | -- | Metakocka API key |
| **AI** | | | |
| `ANTHROPIC_API_KEY` | Yes | -- | Anthropic API key (AI categorization via Claude; required at startup) |
| **Database** | | | |
| `MONGO_URI` | Yes | -- | MongoDB connection string |
| `MONGO_DB_NAME` | Yes | -- | MongoDB database name |
| **Security** | | | |
| `WEBHOOK_API_KEY` | Yes | -- | Secret key for webhook endpoint authentication |

### Environment File Loading

The API loads environment files from `DATA_PATH` (or the project root if not set):

- **Production:** loads `.env` only
- **Development:** loads `.env`, then overlays `.env.development` with `override: true`

---

## Docker

### Dockerfile

The project includes a multi-stage Dockerfile optimized for production:

1. **Base stage** -- Node.js Alpine
2. **Dependencies stage** -- installs production deps with `npm ci`
3. **Production stage** -- copies deps + source, creates `/data` directory, runs as non-root `node` user

### Build & Run

```bash
# Build
docker build -t patrik-export-api .

# Run
docker run -d \
  --name export-api \
  -p 3000:3000 \
  -v /path/to/data:/data \
  --env-file .env \
  patrik-export-api
```

### Data Volume

Mount a host directory to `/data` inside the container. This is where:

- `.env` file is read from (via `DATA_PATH=/data`)
- Downloaded CSV files are stored during sync
- Any runtime data files are written

```bash
-v /path/to/data:/data
```

### Build & Push Script

Use the included scripts to build and push to Docker Hub:

```bash
# Linux / macOS
./scripts/build-and-push.sh

# Windows
scripts\build-and-push.cmd
```

These build the image as `etiamsi/t4a-export-api` and push to the registry.

---

## Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure all required environment variables
- [ ] Ensure MongoDB is accessible from the deployment environment
- [ ] Set a strong, unique `WEBHOOK_API_KEY`
- [ ] Mount persistent volume to `/data` for Docker deployments
- [ ] Verify PNV and Metakocka connectivity via the [health endpoint](api/health.md)
- [ ] Set up n8n webhook workflows for scheduled syncs
- [ ] (Optional) Configure Auth0 for JWT authentication
- [ ] Set `ANTHROPIC_API_KEY` for AI categorization (Claude)

---

## Health Monitoring

After deployment, verify all dependencies are connected:

```bash
curl https://your-server.com/api/export/health
```

Expected response with all services healthy:

```json
{
  "status": "ok",
  "dependencies": {
    "database": "ok",
    "pnv": "ok",
    "metakocka": "ok"
  }
}
```

See [Health Check API](api/health.md) for details on status values and troubleshooting.
