/**
 * ANAS ERP Firebase snapshot Worker
 * Deploy separately to Cloudflare Workers. Configure FIREBASE_API_KEY and FIREBASE_PROJECT_ID.
 * Uses Firebase Auth ID tokens and Firestore Security Rules; no service-account private key.
 */
const MAX_BODY_BYTES = 700 * 1024;
const allowedOrigins = (env) => (env.ALLOWED_ORIGINS || "https://amin545677-svg.github.io")
  .split(",").map(s => s.trim()).filter(Boolean);

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin || "https://amin545677-svg.github.io",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept",
      "Vary": "Origin"
    }
  });
}

function responseOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  return allowedOrigins(env).includes(origin) ? origin : "";
}

async function verifyFirebaseToken(token, env) {
  if (!env.FIREBASE_API_KEY || !env.FIREBASE_PROJECT_ID) {
    throw new Error("Worker is missing FIREBASE_API_KEY or FIREBASE_PROJECT_ID");
  }
  const res = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
    encodeURIComponent(env.FIREBASE_API_KEY), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token })
    });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.users || !data.users[0] || !data.users[0].localId) {
    throw new Error("Firebase ID token is invalid or expired");
  }
  return data.users[0].localId;
}

function firestoreUrl(env, uid) {
  const doc = "users/" + encodeURIComponent(uid) + "/snapshots/latest";
  return "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(env.FIREBASE_PROJECT_ID) +
    "/databases/(default)/documents/" + doc;
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateSnapshotNumber(record, field, label, { allowNegative = false, allowZero = true } = {}) {
  if (!Object.prototype.hasOwnProperty.call(record, field)) return;
  const raw = record[field];
  if ((typeof raw !== "number" && typeof raw !== "string") || raw === null ||
      (typeof raw === "string" && raw.trim() === "")) {
    throw new Error(label + "." + field + " must be an explicit number");
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER ||
      (!allowNegative && value < 0) || (!allowZero && value === 0)) {
    throw new Error(label + "." + field + " is outside the safe numeric range");
  }
}

function validateSnapshotData(data) {
  if (!isRecord(data) || !Array.isArray(data.products) || !Array.isArray(data.customers)) {
    throw new Error("Snapshot does not match the ANAS ERP data structure");
  }
  const arrays = ["products", "customers", "suppliers", "invoices", "purchases", "expenses",
    "cashMovements", "stockMovements", "warehouseTransfers", "truckTrips", "returns",
    "purchaseInvoices", "trucks", "users", "alerts"];
  for (const key of arrays) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    if (!Array.isArray(data[key]) || data[key].length > 200000 ||
        data[key].some(row => !isRecord(row))) {
      throw new Error("Snapshot collection " + key + " is invalid");
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, "warehouses") &&
      (!Array.isArray(data.warehouses) || data.warehouses.length > 200000 ||
       data.warehouses.some(w => !(typeof w === "string" && w.trim()) &&
         (!isRecord(w) || typeof w.name !== "string" || !w.name.trim())))) {
    throw new Error("Snapshot warehouses are invalid");
  }
  if (Object.prototype.hasOwnProperty.call(data, "caisseBalance")) {
    validateSnapshotNumber(data, "caisseBalance", "caisseBalance");
  }

  const uniqueIds = (key, requireId = false) => {
    const seen = new Set();
    for (const row of data[key] || []) {
      if (row.id == null || String(row.id).trim() === "") {
        if (requireId) throw new Error("Snapshot " + key + " record is missing an ID");
        continue;
      }
      const id = String(row.id).trim();
      if (seen.has(id)) throw new Error("Snapshot " + key + " contains duplicate IDs");
      seen.add(id);
    }
  };
  uniqueIds("products", true);
  uniqueIds("customers");
  uniqueIds("suppliers");
  uniqueIds("invoices");
  uniqueIds("truckTrips");

  for (const product of data.products) {
    validateSnapshotNumber(product, "stock", "products.stock");
    if (Object.prototype.hasOwnProperty.call(product, "warehouseStock")) {
      if (!isRecord(product.warehouseStock)) throw new Error("Snapshot product warehouseStock is invalid");
      for (const [warehouse, balance] of Object.entries(product.warehouseStock)) {
        if (!warehouse.trim()) throw new Error("Snapshot warehouseStock contains a blank warehouse");
        validateSnapshotNumber({ balance }, "balance", "products.warehouseStock");
      }
    }
  }
  for (const customer of data.customers) validateSnapshotNumber(customer, "debt", "customers.debt");
  for (const supplier of data.suppliers || []) validateSnapshotNumber(supplier, "balance", "suppliers.balance");
  for (const invoice of data.invoices || []) {
    for (const field of ["total", "paid", "remaining"]) validateSnapshotNumber(invoice, field, "invoices");
    if (invoice.total != null && invoice.paid != null && Number(invoice.paid) > Number(invoice.total) + 0.000001)
      throw new Error("Snapshot invoice paid amount exceeds total");
    if (invoice.total != null && invoice.paid != null && invoice.remaining != null &&
        Math.abs(Number(invoice.remaining) - Math.max(0, Number(invoice.total) - Number(invoice.paid))) > 0.01)
      throw new Error("Snapshot invoice balances are inconsistent");
    if (Object.prototype.hasOwnProperty.call(invoice, "items")) {
      if (!Array.isArray(invoice.items) || invoice.items.length > 10000 || invoice.items.some(item => !isRecord(item)))
        throw new Error("Snapshot invoice items are invalid");
      for (const item of invoice.items) {
        validateSnapshotNumber(item, "qty", "invoices.items", { allowZero: false });
        validateSnapshotNumber(item, "price", "invoices.items");
      }
    }
  }
  for (const purchase of data.purchases || []) {
    for (const field of ["cost", "qty", "total"]) validateSnapshotNumber(purchase, field, "purchases", { allowZero: false });
  }
  for (const expense of data.expenses || []) {
    validateSnapshotNumber(expense, "amt", "expenses", { allowZero: false });
    validateSnapshotNumber(expense, "amount", "expenses", { allowZero: false });
  }
  for (const movement of data.cashMovements || [])
    validateSnapshotNumber(movement, "amount", "cashMovements", { allowZero: false });
  for (const movement of data.stockMovements || []) {
    for (const field of ["qty", "quantity", "delta"])
      validateSnapshotNumber(movement, field, "stockMovements", { allowNegative: true });
    for (const field of ["previousStock", "newStock", "stockBefore", "stockAfter"])
      validateSnapshotNumber(movement, field, "stockMovements");
  }
  for (const transfer of data.warehouseTransfers || []) {
    if (!Object.prototype.hasOwnProperty.call(transfer, "quantity"))
      throw new Error("Snapshot warehouse transfer is missing quantity");
    validateSnapshotNumber(transfer, "quantity", "warehouseTransfers", { allowZero: false });
    for (const field of ["buyPrice", "salePrice", "buyTotal", "saleTotal"]) {
      if (transfer[field] !== null) validateSnapshotNumber(transfer, field, "warehouseTransfers");
    }
  }
  for (const trip of data.truckTrips || []) {
    validateSnapshotNumber(trip, "cost", "truckTrips");
    validateSnapshotNumber(trip, "weight", "truckTrips");
    if (Object.prototype.hasOwnProperty.call(trip, "stockItems")) {
      if (!Array.isArray(trip.stockItems) || trip.stockItems.length > 10000 || trip.stockItems.some(item => !isRecord(item)))
        throw new Error("Snapshot truck stockItems are invalid");
      const seenProducts = new Set();
      for (const item of trip.stockItems) {
        if (item.productId == null || String(item.productId).trim() === "" ||
            !Object.prototype.hasOwnProperty.call(item, "qty"))
          throw new Error("Snapshot truck load item is missing productId or qty");
        const id = String(item.productId).trim();
        if (seenProducts.has(id)) throw new Error("Snapshot truck load contains duplicate product IDs");
        seenProducts.add(id);
        validateSnapshotNumber(item, "qty", "truckTrips.stockItems", { allowZero: false });
      }
    }
  }
}

async function handleSnapshot(request, env, origin) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return json({ error: "Missing Firebase bearer token" }, 401, origin);

  let uid;
  try { uid = await verifyFirebaseToken(match[1], env); }
  catch (e) { return json({ error: e.message || "Firebase authentication failed" }, 401, origin); }

  const url = firestoreUrl(env, uid);
  const headers = { "Authorization": "Bearer " + match[1], "Content-Type": "application/json" };

  if (request.method === "GET") {
    const res = await fetch(url, { headers: { "Authorization": headers.Authorization }, cache: "no-store" });
    if (res.status === 404) return json({ ok: true, exists: false, revision: null }, 200, origin);
    const raw = await res.text();
    if (!res.ok) return json({ error: "Firestore read failed", details: raw.slice(0, 500) }, res.status, origin);
    let doc;
    try { doc = JSON.parse(raw); } catch (_) { return json({ error: "Invalid Firestore response" }, 502, origin); }
    const payload = doc.fields && doc.fields.payload && doc.fields.payload.stringValue;
    if (new URL(request.url).searchParams.get("metadata") === "1") {
      return json({ ok: true, exists: !!payload, revision: doc.updateTime || null }, 200, origin);
    }
    if (!payload) return json({ ok: true, exists: false, data: "", revision: doc.updateTime || null }, 200, origin);
    return json({ ok: true, exists: true, data: payload, parts: 1, revision: doc.updateTime || null }, 200, origin);
  }

  if (request.method === "POST") {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return json({ error: "Snapshot exceeds 700 KiB limit" }, 413, origin);
    }
    let body;
    try { body = JSON.parse(text); } catch (_) { return json({ error: "Request body must be valid JSON" }, 400, origin); }
    if (!body || typeof body !== "object" || typeof body.data !== "string" || !body.data) {
      return json({ error: "Expected serialized application JSON in the data field" }, 400, origin);
    }
    let appData;
    try { appData = JSON.parse(body.data); } catch (_) { return json({ error: "Snapshot data is not valid JSON" }, 400, origin); }
    try { validateSnapshotData(appData); }
    catch (e) { return json({ error: "Snapshot failed integrity validation", details: String(e.message || e).slice(0, 300) }, 400, origin); }
    const payload = body.data;
    const qs = new URLSearchParams();
    qs.append("updateMask.fieldPaths", "payload");
    qs.append("updateMask.fieldPaths", "updatedAt");
    // New clients provide the updateTime they observed before preparing this upload.
    // Firestore enforces this precondition atomically, preventing stale snapshots from overwriting newer ones.
    if (Object.prototype.hasOwnProperty.call(body, "revision")) {
      if (body.revision === null) qs.set("currentDocument.exists", "false");
      else if (typeof body.revision === "string" && body.revision.trim()) qs.set("currentDocument.updateTime", body.revision);
      else return json({ error: "Invalid snapshot revision; refresh the cloud snapshot metadata and retry." }, 400, origin);
    }
    const res = await fetch(url + "?" + qs.toString(), {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fields: {
        payload: { stringValue: payload },
        updatedAt: { stringValue: new Date().toISOString() }
      } })
    });
    const raw = await res.text();
    if (!res.ok) {
      let failure = {};
      try { failure = JSON.parse(raw); } catch (_) {}
      const reason = failure.error && (failure.error.status || failure.error.message) || "";
      if (Object.prototype.hasOwnProperty.call(body, "revision") &&
          (res.status === 409 || /FAILED_PRECONDITION|update time|precondition/i.test(String(reason)))) {
        return json({ error: "Snapshot conflict: the cloud copy changed after it was read. Download the latest copy and retry.", conflict: true }, 409, origin);
      }
      return json({ error: "Firestore write failed. Check Firestore rules and database setup.", details: raw.slice(0, 500) }, res.status, origin);
    }
    let savedDoc = {};
    try { savedDoc = JSON.parse(raw); } catch (_) {}
    return json({ ok: true, saved: true, uid, parts: 1, updatedAt: new Date().toISOString(), revision: savedDoc.updateTime || null }, 200, origin);
  }

  return json({ error: "Method not allowed" }, 405, origin);
}

export default {
  async fetch(request, env) {
    const origin = responseOrigin(request, env);
    if (request.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
      }});
    }
    const url = new URL(request.url);
    if (!origin) return json({ error: "Origin is not allowed" }, 403, "https://amin545677-svg.github.io");
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "anas-erp-firebase-snapshot", configured: !!(env.FIREBASE_API_KEY && env.FIREBASE_PROJECT_ID) }, 200, origin);
    }
    if (url.pathname === "/snapshot") {
      if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
      try { return await handleSnapshot(request, env, origin); }
      catch (e) { return json({ error: "Worker internal error", details: String(e.message || e).slice(0, 300) }, 500, origin); }
    }
    return json({ error: "Not found" }, 404, origin);
  }
};
