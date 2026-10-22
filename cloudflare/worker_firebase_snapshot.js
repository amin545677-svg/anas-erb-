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
    if (res.status === 404) return json({ ok: true, exists: false }, 200, origin);
    const raw = await res.text();
    if (!res.ok) return json({ error: "Firestore read failed", details: raw.slice(0, 500) }, res.status, origin);
    let doc;
    try { doc = JSON.parse(raw); } catch (_) { return json({ error: "Invalid Firestore response" }, 502, origin); }
    const payload = doc.fields && doc.fields.payload && doc.fields.payload.stringValue;
    if (!payload) return json({ ok: true, exists: false, data: "" }, 200, origin);
    return json({ ok: true, exists: true, data: payload, parts: 1 }, 200, origin);
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
    if (!appData || typeof appData !== "object" || !Array.isArray(appData.products) || !Array.isArray(appData.customers)) {
      return json({ error: "Snapshot does not match the ANAS ERP data structure" }, 400, origin);
    }
    const payload = body.data;
    const qs = new URLSearchParams();
    qs.append("updateMask.fieldPaths", "payload");
    qs.append("updateMask.fieldPaths", "updatedAt");
    const res = await fetch(url + "?" + qs.toString(), {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fields: {
        payload: { stringValue: payload },
        updatedAt: { stringValue: new Date().toISOString() }
      } })
    });
    const raw = await res.text();
    if (!res.ok) return json({ error: "Firestore write failed. Check Firestore rules and database setup.", details: raw.slice(0, 500) }, res.status, origin);
    return json({ ok: true, saved: true, uid, parts: 1, updatedAt: new Date().toISOString() }, 200, origin);
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
