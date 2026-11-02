'use strict';

const MAX_STORE_IDS = 32;

function cleanId(value, label, max = 160) {
  if (typeof value !== 'string') throw new Error(label + ' must be a string');
  const id = value.trim();
  if (!id || id.length > max || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error(label + ' is invalid');
  }
  return id;
}

function readStagingGrantScope(env = process.env) {
  const tenantId = cleanId(env.ANAS_STAGING_TENANT_ID, 'ANAS_STAGING_TENANT_ID');
  let parsed;
  try {
    parsed = JSON.parse(String(env.ANAS_STAGING_STORE_IDS_JSON || ''));
  } catch {
    throw new Error('ANAS_STAGING_STORE_IDS_JSON must be a JSON array of staging store IDs');
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_STORE_IDS) {
    throw new Error('ANAS_STAGING_STORE_IDS_JSON must contain between 1 and ' + MAX_STORE_IDS + ' store IDs');
  }
  const storeIds = parsed.map((value, index) => cleanId(value, 'staging store ID at index ' + index));
  if (new Set(storeIds).size !== storeIds.length) {
    throw new Error('ANAS_STAGING_STORE_IDS_JSON must not contain duplicate store IDs');
  }
  return Object.freeze({ tenantId, storeIds: Object.freeze(storeIds) });
}

function assertExistingGrantScope(grant, expected) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    throw new Error('Existing staging financial grant is malformed');
  }
  if (grant.tenantId != null && grant.tenantId !== expected.tenantId) {
    throw new Error('Existing staging grant belongs to a different tenant; refusing to rewrite its scope');
  }
  if (grant.storeIds != null) {
    const existingStores = Array.isArray(grant.storeIds) ? [...grant.storeIds].sort() : null;
    const expectedStores = [...expected.storeIds].sort();
    if (!existingStores || existingStores.some(value => typeof value !== 'string') ||
        existingStores.length !== expectedStores.length ||
        existingStores.some((value, index) => value !== expectedStores[index])) {
      throw new Error('Existing staging grant has a different store scope; refusing to rewrite its scope');
    }
  }
  return true;
}

module.exports = Object.freeze({ readStagingGrantScope, assertExistingGrantScope });
