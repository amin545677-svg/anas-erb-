# ANAS ERP — User and Permission Security Foundation (V42)

## Status

This change introduces a **server-side authorization policy primitive and regression tests only**. It does not activate employee authentication, shared multi-device membership, or production authorization.

## Existing verified constraints

- The production application shell is identified as V42; keep that identity unchanged.
- Existing `AppData.users` and `AppData.currentUser` are local application data. Switching the selected record is not Firebase Authentication.
- Existing user permission checkboxes persist preferences but do not enforce every business operation.
- The current Firestore rule at `firebase/firestore.rules` scopes snapshot documents to the matching authenticated UID. It does not define organization membership or shared tenant data.

## Authorization contract

Trusted server handlers must:
1. Require Firebase Authentication and use only `request.auth.uid` as caller identity.
2. Load the caller's membership from Firestore using Admin SDK; never trust role, tenant, permissions, or store IDs sent by the browser.
3. Require an active membership bound to that UID and a non-empty tenant ID.
4. Check tenant and store scope for every resource operation.
5. Check a known, explicit permission ID for every operation; unknown permission IDs fail closed.
6. Prevent self role changes and self-disable operations.
7. Record sensitive authorization changes in an append-only audit collection in the same transaction as the protected state change where feasible.

## Policy module

`security/user-rbac-policy.mjs` is a pure server-side decision helper. It expects a trusted membership record already loaded by the server. It is not a callable endpoint, an authentication mechanism, or a substitute for Firestore Security Rules.

## Required next implementation

- Define tenant membership and store assignment document schemas.
- Add Admin-SDK callable endpoints for invitation/activation, permission updates, and disable/reactivate.
- Add Firestore rules for tenant membership, data partitioning, and immutable audit records; preserve the existing personal snapshot path until a verified migration exists.
- Add App Check and Firebase Auth checks to all sensitive callable endpoints.
- Wire the V42 UI to authenticated sessions and server-provided capabilities; remove local user switching as an authorization mechanism.
- Add emulator tests for cross-tenant reads/writes, store isolation, disabled accounts, privilege escalation, audit immutability, and concurrent role changes.
- Run staging-only browser tests with two dedicated test accounts before considering any production rollout.

## Safety boundary

No production rules, production data, credentials, existing user records, or application UI are changed by this foundation. Do not grant production roles or deploy it as a complete user-management system.
