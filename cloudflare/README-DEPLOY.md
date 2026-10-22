# ANAS ERP Cloudflare Worker — deployment notes

The full ANAS ERP site is deployed on GitHub Pages. The Firebase snapshot Worker is a separate service and is not deployed by GitHub Pages.

## Cloudflare Worker setup
1. Create a NEW Cloudflare Worker named `anas-erp-firebase-snapshot`. Do not overwrite the existing Gemini/AI Worker.
2. Paste `cloudflare/worker_firebase_snapshot.js` into its editor.
3. Add Worker environment variables:
   - `FIREBASE_API_KEY`: the Web API key from Firebase project settings (not a password or service-account secret).
   - `FIREBASE_PROJECT_ID`: `anas-erb`.
   - `ALLOWED_ORIGINS`: `https://amin545677-svg.github.io` (comma-separated if you later add another exact origin).
4. Deploy the Worker and copy its HTTPS URL.
5. In ANAS ERP > Firebase/Cloud backup settings, paste the Worker URL and use the built-in Worker connection test.
6. In Firebase Authentication, enable the provider you intend to use and add `amin545677-svg.github.io` under Authorized domains.
7. In Firestore, review your existing rules before changing them. The included `firestore.rules` demonstrates the minimum user-scoped rule needed for the snapshot path. Do not blindly replace existing rules if the app uses other collections; merge carefully.

## Important limitations
- This Worker is separate from the site's GitHub Pages deployment. It cannot be deployed to your Cloudflare account from GitHub without your Cloudflare account authorization.
- The Worker only stores manual snapshots, not realtime sync.
- Snapshot payloads are capped at 700 KiB to stay below Firestore document limits.
- Restore/write must be tested with a non-critical test account and a downloaded local backup first.
- Never put a service-account private key in this repository. The Firebase Web API key is a client identifier, but should still be restricted appropriately in Google Cloud if feasible.
