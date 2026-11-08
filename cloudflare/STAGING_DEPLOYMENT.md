# Firebase Snapshot Worker — Staging isolation

This configuration is intentionally separate from `wrangler.toml`, which targets the production Firebase project.

## Staging-only deployment

From the repository root:

```sh
npx wrangler secret put FIREBASE_API_KEY --config cloudflare/wrangler-staging.toml
npx wrangler deploy --config cloudflare/wrangler-staging.toml
```

Before deployment, confirm that the Cloudflare account is the intended account and that the secret is the Firebase Web API key belonging to the dedicated Firebase project `anas-erp-staging-a25e1`. Never copy the production key into this Worker.

The Worker name is `anas-erp-firebase-snapshot-staging`; it must remain distinct from the production Worker `anas-erp-firebase-snapshot`.

## Required post-deploy checks

1. GET `/health` returns `ok: true`, `configured: true`, and the staging Worker service identity.
2. An unauthenticated `/snapshot` request is rejected with HTTP 401.
3. An origin outside `ALLOWED_ORIGINS` is rejected with HTTP 403.
4. Use a dedicated staging Firebase account to verify snapshot read, create, revision conflict (HTTP 409), and read-after-write.
5. Confirm the document is written only under the staging Firebase project. Do not test with production users or production data.

This file does not deploy anything and does not provision secrets. Deployment remains an explicit operator action after the staging project, Firestore rules, and Cloudflare secret are verified.
