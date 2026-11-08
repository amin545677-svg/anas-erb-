# Deploy the ANAS ERP Firebase Worker

This workflow deploys a separate Cloudflare Worker. It is intentionally separate from the Gemini/AI Worker and the GitHub Pages site.

## Required GitHub Actions repository secrets
In GitHub: Settings → Secrets and variables → Actions → New repository secret, add:
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with permission to edit Workers for this account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.
- `FIREBASE_API_KEY`: the Firebase Web API key for project `anas-erb`.

Do not put a Cloudflare token in source code or chat. The Firebase Web API key is a client identifier, not a password; apply suitable API restrictions in Google Cloud.

After adding the secrets, open Actions → **Deploy ANAS ERP Firebase Worker** → Run workflow. On success, copy the Worker URL from Cloudflare and paste it into the app's Firebase/Cloud backup settings. Then run the built-in `/health` test.

Before using snapshots with business data, configure Firestore rules carefully and test upload/restore using a test account and a local export. The worker stores a single per-user snapshot document and caps the serialized payload at 700 KiB.
