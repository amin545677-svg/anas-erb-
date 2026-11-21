/**
 * ANAS ERP trusted authorization policy (server-side foundation).
 *
 * IMPORTANT:
 * - Call only from trusted server code after loading membership from Firestore Admin SDK.
 * - Never pass client-supplied membership/permissions as the authority.
 * - This module does not authenticate users or replace Firestore/Functions enforcement.
 */
export const USER_PERMISSION_IDS = Object.freeze([
  "dashboard.read",
  "sales.read", "sales.create", "sales.update", "sales.cancel",
  "purchases.read", "purchases.create", "purchases.update",
  "customers.read", "customers.update",
  "suppliers.read", "suppliers.update",
  "inventory.read", "inventory.adjust", "inventory.transfer",
  "returns.read", "returns.create", "returns.approve",
  "cashbox.read", "cashbox.receive", "cashbox.pay", "cashbox.expense",
  "reports.read",
  "users.read", "users.create", "users.update", "users.disable", "users.manage_roles",
  "settings.read", "settings.update",
  "backup.create", "backup.restore",
  "reverse_sale_return",
  "reverse_purchase_return",
  "reverse_invoice_cancel",
  "settlement_allocation_post"
]);

const KNOWN_PERMISSIONS = new Set(USER_PERMISSION_IDS);

function deny(reason) {
  return Object.freeze({ allowed: false, reason });
}

function allow() {
  return Object.freeze({ allowed: true, reason: "allowed" });
}

/**
 * @param {{
 *   auth: { uid?: string } | null,
 *   membership: {
 *     uid?: string, tenantId?: string, status?: string,
 *     permissions?: string[], storeIds?: string[]
 *   } | null,
 *   action: string,
 *   resource?: { tenantId?: string, storeId?: string } | null,
 *   targetUid?: string
 * }} input
 */
export function authorizeUserOperation(input = {}) {
  const { auth, membership, action, resource = null, targetUid } = input;

  if (!auth || typeof auth.uid !== "string" || !auth.uid.trim()) {
    return deny("unauthenticated");
  }
  if (!membership || typeof membership !== "object") {
    return deny("membership_missing");
  }
  if (membership.uid !== auth.uid) {
    return deny("membership_uid_mismatch");
  }
  if (String(membership.status || (membership.active === true ? "active" : "")).toLowerCase() !== "active") {
    return deny("membership_inactive");
  }
  if (typeof membership.tenantId !== "string" || !membership.tenantId.trim()) {
    return deny("tenant_missing");
  }
  if (resource?.tenantId && resource.tenantId !== membership.tenantId) {
    return deny("tenant_scope_mismatch");
  }
  if (typeof action !== "string" || !KNOWN_PERMISSIONS.has(action)) {
    return deny("unknown_permission");
  }
  if (!Array.isArray(membership.permissions) ||
      membership.permissions.some((permission) =>
        typeof permission !== "string" || !KNOWN_PERMISSIONS.has(permission)
      )) {
    return deny("invalid_permission_set");
  }
  if (!membership.permissions.includes(action)) {
    return deny("permission_denied");
  }

  if (resource?.storeId) {
    if (!Array.isArray(membership.storeIds) ||
        !membership.storeIds.includes(resource.storeId)) {
      return deny("store_scope_denied");
    }
  }

  // Prevent an operator from elevating or disabling their own account.
  if (action === "users.manage_roles" && targetUid === auth.uid) {
    return deny("self_role_change_forbidden");
  }
  if (action === "users.disable" && targetUid === auth.uid) {
    return deny("self_disable_forbidden");
  }

  return allow();
}
