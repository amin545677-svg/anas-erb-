# ANAS ERP Staging — GitHub OIDC setup

This repository deploys only the isolated Firebase project `anas-erp-staging-a25e1`.
The Hosting and Functions deployment jobs use GitHub Actions OIDC and do not require a downloaded service-account JSON key. The optional Firebase Admin SDK test-account bootstrap is separate: Firebase Admin SDK does not currently support Workload Identity Federation directly, so that optional step requires its own dedicated Staging-only service-account key or must be skipped.

## 1. Create the Google Cloud identity pool and provider

Run these commands as a Google Cloud administrator. Use a dedicated pool/provider for this repository.

```bash
export PROJECT_ID="anas-erp-staging-a25e1"
export POOL_ID="github-anas-erp-staging"
export PROVIDER_ID="github-actions"
export DEPLOYER_SA="anas-erp-staging-deployer"

gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)"

gcloud iam workload-identity-pools create "$POOL_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --display-name="ANAS ERP Staging GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="$POOL_ID" \
  --display-name="ANAS ERP Staging GitHub provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == 'amin545677-svg/anas-erb-' && assertion.ref == 'refs/heads/staging/unified-release-candidate'"

gcloud iam service-accounts create "$DEPLOYER_SA" \
  --project="$PROJECT_ID" \
  --display-name="ANAS ERP Staging deployer"
```

If the pool/provider or service account already exists, inspect and reuse it; do not create duplicates.

## 2. Allow only this repository to impersonate the deployer

Set `PROJECT_NUMBER` to the project number printed above.

```bash
export PROJECT_NUMBER="<PROJECT_NUMBER>"
export MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/amin545677-svg/anas-erb-"

gcloud iam service-accounts add-iam-policy-binding \
  "${DEPLOYER_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="$MEMBER"
```

The provider condition restricts tokens to pushes or manual dispatches whose ref is exactly `refs/heads/staging/unified-release-candidate` in this repository. The workflows also scope `id-token: write` to the deployment job and reject manual dispatches from other branches. Do not remove these restrictions or grant this identity access to the production project.

## 3. Grant deployment permissions

Grant the deployer service account only the permissions required by the enabled Firebase operations in the staging project: Hosting deployment, Firestore Rules deployment, and the selected Cloud Functions deployment. Include `iam.serviceAccounts.actAs` only on the specific Functions runtime service account if required. Do not grant Owner or Editor as a shortcut. Validate the required role set against the actual deployment errors and the project's existing runtime service accounts.

## 4. Configure GitHub Environment variables

In repository Settings → Environments → `staging` → Environment variables, add:

- `ANAS_STAGING_WIF_PROVIDER`: full provider resource name, for example `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID`.
- `ANAS_STAGING_DEPLOYER_SERVICE_ACCOUNT`: `anas-erp-staging-deployer@anas-erp-staging-a25e1.iam.gserviceaccount.com` (or the exact dedicated deployer account selected above).

The console workflow still requires these public Firebase web configuration inputs as GitHub Environment secrets:

- `FIREBASE_STAGING_WEB_API_KEY`
- `FIREBASE_STAGING_WEB_APP_ID`
- `FIREBASE_STAGING_APP_CHECK_SITE_KEY`

The Functions workflow's optional test-account bootstrap separately requires `ANAS_STAGING_EMAIL`, `ANAS_STAGING_PASSWORD`, and `FIREBASE_STAGING_BOOTSTRAP_SERVICE_ACCOUNT` (a dedicated Staging-only Admin SDK service-account JSON secret), plus the following Environment variables so the trusted grant is scoped correctly:

- `ANAS_STAGING_TENANT_ID`: the exact tenant ID used by the synthetic Staging records.
- `ANAS_STAGING_STORE_IDS_JSON`: a JSON array of permitted Staging store IDs, for example `[\"staging-store-01\"]`.

Optionally set `ANAS_STAGING_UID` / `STAGING_TEST_UID` to pin the test account UID. The bootstrap refuses to overwrite an existing grant with a different tenant or store scope. This key is not used by either deployment command. It is written to a temporary runner file only for the optional bootstrap step, validated against `anas-erp-staging-a25e1`, and deleted when that step exits. If you do not want any long-lived key, leave this secret unset and provision the isolated test account through a separately approved administrative process; the workflow will skip bootstrap rather than attempt unsupported Admin SDK WIF.

## 5. Rotate Staging web configuration safely

The Firebase Web API key, Web App ID, and App Check site key are public client configuration values, not server credentials. They must still be scoped to the isolated Staging project and must never be confused with the Admin SDK or deployment identity.

1. In Firebase Console, select only project `anas-erp-staging-a25e1`. Confirm the registered Web App and App Check provider belong to that project.
2. In Google Cloud Console → APIs & Services → Credentials for the same project, create a replacement API key. Restrict its HTTP referrers to the exact Staging Hosting origin(s), and restrict API usage to the Firebase/Google APIs actually required by this client. Validate sign-in, token refresh, App Check and callable requests before revoking the old key.
3. Obtain the Web App ID from the Staging Web App settings and the App Check site key from the Staging App Check provider configuration. Do not copy either value from Production.
4. Replace the GitHub Environment `staging` values `FIREBASE_STAGING_WEB_API_KEY`, `FIREBASE_STAGING_WEB_APP_ID`, and `FIREBASE_STAGING_APP_CHECK_SITE_KEY`. Never put these values in source code, commits, issue comments, or chat.
5. Run the dedicated Hosting deployment and verify the served `config.js` contains the Staging project ID and the exact Staging origin. Test Auth, App Check and callable invocation from the deployed Staging origin.
6. Only after successful validation, disable/delete the superseded Staging API key. If the old key was exposed or mis-scoped, revoke it immediately and accept the temporary Staging outage until the replacement is installed.

Do not rotate Production keys as part of this Staging procedure. Do not substitute an API key for a service-account credential: deployment still requires the dedicated Staging OIDC identity or Staging-only service-account credential.

## 6. Run and verify

After configuring the provider, IAM binding, service-account permissions, and Environment variables, dispatch each workflow from `staging/unified-release-candidate` or push a reviewed commit to that branch.

A successful PR validation job is not a deployment. Accept deployment only when the deploy job itself is `success` and the workflow's live Hosting verification / Firebase deployment steps complete. Keep PR #263 Draft until both deployments and live acceptance evidence are complete.
