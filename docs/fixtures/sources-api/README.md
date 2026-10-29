# Sources API fixtures

Recorded replies of the real `/api/v1` routes, the shared evidence that this API and Recharge Hub agree
(`recharge-hub/tests/fixtures/export-portal/` holds the copy it parses in its tests).

Regenerate (needs a throwaway MongoDB; nothing reaches Shopify, MetaKocka, PNV or Anthropic, they are stubbed):

```
MONGO_URI=mongodb://localhost:27099 node scripts/sources-api-smoke.js --record
MONGO_URI=mongodb://localhost:27099 node scripts/sources-api-ai-smoke.js --record
```

Bodies only, anonymised by `scripts/lib/fixtureRecorder.js` (ids and timestamps become placeholders). A refusal's
status is in its file name (`error-422.json`). After regenerating, copy the files to the hub and update the
`sha256` lines in the hub's `tests/fixtures/export-portal/README.md`.

`source.json` is recorded with `SHOPIFY_PORTAL_RETURN_URL` unset, so it has no `portalUrl`: the omitted case.
