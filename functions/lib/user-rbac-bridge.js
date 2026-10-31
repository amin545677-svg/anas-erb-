'use strict';

/**
 * Server-only bridge for financial operations to the canonical reverseLedgerGrants/{uid}.
 * Resource scope is resolved from the transaction-loaded snapshot, never from request data.
 */
const FINANCIAL_ACTIONS = new Set([
  'reverse_sale_return',
  'reverse_purchase_return',
  'reverse_invoice_cancel',
  'settlement_allocation_post'
]);

function authorizeFinancialScope({ uid, grant, action, resource = {}, state = {} }) {
  const deny = message => {
    const error = new Error(message);
    error.code = 'permission-denied';
    throw error;
  };
  if (!uid || !grant || grant.uid !== uid || grant.schemaVersion !== 1) {
    deny('Trusted financial grant is missing or does not match the authenticated user.');
  }
  const status = String(grant.status || (grant.active === true ? 'active' : '')).toLowerCase();
  if (status !== 'active') deny('Financial grant is not active.');
  if (!Array.isArray(grant.permissions) || !grant.permissions.includes(action) ||
      !FINANCIAL_ACTIONS.has(action)) {
    deny('The required financial operation permission is not granted.');
  }
  if (typeof grant.tenantId !== 'string' || !grant.tenantId.trim()) {
    deny('Trusted grant tenant scope is missing.');
  }

  const explicitMultiTenant = state.multiTenantEnabled === true ||
    (Array.isArray(state.tenants) && state.tenants.length > 1);
  const explicitMultiStore = state.multiStoreEnabled === true ||
    (Array.isArray(state.stores) && state.stores.length > 1);

  const resourceTenant = resource.tenantId || state.tenantId ||
    (!explicitMultiTenant ? grant.tenantId : '');
  if (!resourceTenant || resourceTenant !== grant.tenantId) {
    deny('Financial record belongs to a different or unresolved tenant.');
  }

  const storeIds = Array.isArray(grant.storeIds) ? grant.storeIds.filter(
    value => typeof value === 'string' && value.trim()
  ) : [];
  const resourceStore = resource.storeId || resource.warehouseId || state.storeId ||
    (!explicitMultiStore && storeIds.length === 1 ? storeIds[0] : '');
  if (!resourceStore || !storeIds.includes(resourceStore)) {
    deny('Financial record belongs to a store outside the trusted grant scope.');
  }
  return Object.freeze({ authorized: true, tenantId: resourceTenant, storeId: resourceStore, action });
}

module.exports = Object.freeze({ FINANCIAL_ACTIONS, authorizeFinancialScope });
