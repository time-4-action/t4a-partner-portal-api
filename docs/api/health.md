# Health Check API

## Endpoint

```http
GET /api/export/health
```

Public endpoint -- no authentication required. Checks the status of the service and all its dependencies in parallel.

---

## Response `200 OK` -- All Healthy

```json
{
  "status": "ok",
  "version": "1.0.0",
  "appName": "patrik-products-export",
  "timestamp": "2026-01-15T10:00:00.000Z",
  "uptime": 3600.5,
  "memoryUsage": {
    "rss": 12345678,
    "heapUsed": 9876543
  },
  "dependencies": {
    "database": "ok",
    "pnv": "ok",
    "metakocka": "ok"
  }
}
```

## Response `503 Service Unavailable` -- Degraded

Same shape as above with `"status": "error"` and affected dependencies showing `"error"` or `"misconfigured"`.

---

## Dependency Checks

| Dependency | What is checked | Possible values |
|------------|-----------------|-----------------|
| `database` | MongoDB ping | `ok`, `error` |
| `pnv` | HEAD request to `PNV_BASE_URL` (5s timeout) | `ok`, `error`, `misconfigured` |
| `metakocka` | POST to warehouse stock endpoint with `limit=1` (5s timeout) | `ok`, `error`, `misconfigured` |

**Status meanings:**

- **`ok`** -- dependency is reachable and responding
- **`error`** -- dependency is unreachable or returned an error
- **`misconfigured`** -- required environment variables for this dependency are not set
