import test from "node:test";
import assert from "node:assert/strict";
import { authorizeUserOperation } from "../security/user-rbac-policy.mjs";

const auth = { uid: "employee-1" };
const membership = {
  uid: "employee-1",
  tenantId: "tenant-a",
  status: "active",
  permissions: ["sales.read", "sales.create", "users.manage_roles", "users.disable"],
  storeIds: ["store-a"]
};
const decide = (overrides = {}) => authorizeUserOperation({
  auth, membership, action: "sales.create", ...overrides
});

test("allows an authenticated active member with the requested permission", () => {
  assert.deepEqual(decide(), { allowed: true, reason: "allowed" });
});
test("denies missing authentication", () => {
  assert.equal(decide({ auth: null }).reason, "unauthenticated");
});
test("denies missing membership", () => {
  assert.equal(decide({ membership: null }).reason, "membership_missing");
});
test("binds membership to the authenticated UID", () => {
  assert.equal(decide({ membership: { ...membership, uid: "other" } }).reason, "membership_uid_mismatch");
});
test("denies suspended or disabled membership", () => {
  assert.equal(decide({ membership: { ...membership, status: "disabled" } }).reason, "membership_inactive");
});
test("denies cross-tenant resource access", () => {
  assert.equal(decide({ resource: { tenantId: "tenant-b" } }).reason, "tenant_scope_mismatch");
});
test("denies access to an unassigned store", () => {
  assert.equal(decide({ resource: { tenantId: "tenant-a", storeId: "store-b" } }).reason, "store_scope_denied");
});
test("allows access only to an assigned store", () => {
  assert.equal(decide({ resource: { tenantId: "tenant-a", storeId: "store-a" } }).allowed, true);
});
test("denies permissions not explicitly granted", () => {
  assert.equal(decide({ action: "cashbox.pay" }).reason, "permission_denied");
});
test("fails closed on unknown permission IDs", () => {
  assert.equal(decide({ action: "root.all" }).reason, "unknown_permission");
});
test("fails closed when stored permissions contain unknown values", () => {
  assert.equal(decide({ membership: { ...membership, permissions: ["sales.create", "*"] } }).reason, "invalid_permission_set");
});
test("prevents self role elevation", () => {
  assert.equal(decide({ action: "users.manage_roles", targetUid: auth.uid }).reason, "self_role_change_forbidden");
});
test("prevents self disable", () => {
  assert.equal(decide({ action: "users.disable", targetUid: auth.uid }).reason, "self_disable_forbidden");
});
test("does not infer tenant-wide access from an empty store list", () => {
  assert.equal(decide({ resource: { tenantId: "tenant-a", storeId: "store-a" }, membership: { ...membership, storeIds: [] } }).reason, "store_scope_denied");
});
