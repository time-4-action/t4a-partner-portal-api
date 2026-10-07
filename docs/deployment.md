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
| **Scheduling** | | | |
| `PRODUCTS_DOWNLOAD_SCHEDULE` | No | -- | 5-field cron (e.g. `0 * * * *`) for the in-app PNV catalogue refresh (sync → AI categorization → Shopify push). Unset/`off` = disabled (webhook endpoints only) |
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

### Images

Images are built by CI only and live in GitHub Container Registry as
`ghcr.io/time-4-action/t4a-partner-portal-api` (Docker Hub is no longer used). See
[CI/CD](#cicd) below.

---

## CI/CD

`.github/workflows/deploy.yml` (workflow `ci`) runs `check` → `deploy` → `verify`.

**check** runs on every pull request and every push to `main`: `npm ci` and a
`node --check` syntax pass over `index.js` and `src/` (there is no test suite yet).
A newer push to a pull request cancels its running check; runs on `main` are
queued, so pushes deploy strictly in order.

**deploy** runs only on `main` after a green check, one at a time. It builds the
image on GitHub Actions with the commit SHA baked in as `APP_VERSION`, pushes
`ghcr.io/time-4-action/t4a-partner-portal-api:<sha>` and `:latest`, then SSHes to
the VM and, in `DEPLOY_DIR` (default `/data/stack/apps/time-4-action/export/api`):

1. records the image the running `t4a-partner-portal-api` container uses;
2. logs in to `ghcr.io` with the job's own `GITHUB_TOKEN` (valid only while the
   job runs; logged out again on exit, so the VM stores no registry credential),
   `docker compose pull` (three attempts) and `docker compose up -d` with
   `APP_IMAGE` exported to the new SHA;
3. waits up to 120 s for `/api/export/healthz` on the container's published port
   (read with `docker compose port`) to answer 200;
4. checks the container reports `APP_VERSION` equal to the commit SHA.

If 3 or 4 fails it prints the logs, rolls back to the recorded image and fails
the run. **verify** then requests `/api/export/healthz` on the public URL
(`https://api.time-4-action.com`, override with the `PRODUCTION_URL` repository
variable).

`/api/export/healthz` is a bare liveness probe: no auth, no logging, no MongoDB,
PNV or Metakocka. The process only listens after MongoDB connected at startup, so
"up" still means the app booted; a later dependency outage never triggers a
rollback. `/api/export/health` remains the detailed dependency check.

The deploy only swaps images. The `.env` (in the mounted data directory) and
`docker-compose.yaml` on the server are edited by hand; the server copy of the
compose file is `deploy/docker-compose.yaml` (the root one is for local builds).
To go back to an older release, re-run that commit's workflow, or on the server:
`export APP_IMAGE=ghcr.io/time-4-action/t4a-partner-portal-api:<sha> && docker compose up -d`
(a `docker login ghcr.io` first, the package is private).

### GitHub settings

Pushing and pulling use the workflow's `GITHUB_TOKEN` (`packages: write` on the
deploy job), so there is no registry secret. The `org.opencontainers.image.source`
label in the Dockerfile links the package to this repository.

Organization secrets (same values as in t4a-admin):

| Secret               | Value |
| -------------------- | ----- |
| `PROD_DEPLOY_HOST`        | The VM's hostname or IP |
| `PROD_DEPLOY_SSH_KEY`     | Private key whose public half is in `deploy`'s `authorized_keys` |
| `PROD_DEPLOY_FINGERPRINT` | `SHA256:…` from `ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub` |

Optional repository variables: `DEPLOY_USER` (default `deploy`), `DEPLOY_DIR`,
`PRODUCTION_URL`.

### Server setup (once)

The server's `docker-compose.yaml` must be `deploy/docker-compose.yaml`. A copy with
a fixed `image:` tag ignores `APP_IMAGE`, so every deploy would fail its
`APP_VERSION` check and roll back. The service was renamed from `app` (with a fixed
`container_name`) to `t4a-partner-portal-api`, so switch over once by hand:

```bash
cd /data/stack/apps/time-4-action/export/api
docker compose down            # with the OLD compose file still in place
# replace docker-compose.yaml with deploy/docker-compose.yaml
echo "$PAT" | docker login ghcr.io -u <github-user> --password-stdin   # read:packages
docker compose up -d && docker logout ghcr.io
```

### Dependency updates

`.github/dependabot.yml` opens at most one grouped pull request per ecosystem a
month (npm minor + patch, GitHub Actions); each goes through `check`.

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
