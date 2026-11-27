/**
 * Stable, idempotent bridge from immutable fleet audit events to AppData.auditTrail.
 * Every fleet audit record is associated with its originating truck trip.
 */
function canonical(value) {
  if (typeof value === "bigint") return {__fleetBigInt: value.toString()};
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
function fingerprint(value) {
  const input = JSON.stringify(canonical(value));
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
export function mergeFleetAuditTrail(target, source) {
  if (!Array.isArray(target)) throw new TypeError("AppData.auditTrail must be an array");
  if (!Array.isArray(source)) throw new TypeError("Fleet auditTrail must be an array");
  const known = new Set(target.map(row => String(row?.id ?? "")).filter(Boolean));
  let appended = 0;
  for (const row of source) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const identity = {
      eventType: String(row.eventType || row.type || "TRUCK_FLEET_EVENT"),
      tripId: row.tripId ?? null,
      saleId: row.saleId ?? null,
      settlementId: row.settlementId ?? null,
      idempotencyKey: row.idempotencyKey ?? null,
      referenceId: row.referenceId ?? null,
      productId: row.productId ?? null
    };
    const hasMovementIdentity = Object.entries(identity).some(([key, value]) =>
      key !== "eventType" && value !== null && value !== ""
    );
    const id = "FLEET-AUDIT-" + fingerprint(hasMovementIdentity ? identity : row);
    if (known.has(id)) continue;
    const entityId = row.tripId ?? row.entityId ?? row.saleId ?? row.settlementId ?? id;
    const safeRow = canonical(row);
    target.push({
      ...safeRow,
      id,
      eventType: String(row.eventType || row.type || "TRUCK_FLEET_EVENT"),
      entityType: "truck_trip",
      entityId: String(entityId)
    });
    known.add(id);
    appended++;
  }
  return appended;
}
