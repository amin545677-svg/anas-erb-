/**
 * Explicit transport adapter for the ANAS ERP Firebase Snapshot Worker.
 *
 * Worker contract:
 *   GET  /snapshot[?metadata=1] -> { data: serialized JSON, revision, exists }
 *   POST /snapshot { data: serialized JSON, revision } -> { saved, revision }
 *
 * This adapter is intentionally isolated from production V42. It bridges the
 * queue orchestrator's object/baseRevision contract to the Worker wire format.
 */
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

function normalizeBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); }
  catch { throw new Error("A valid Worker base URL is required"); }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))) {
    throw new Error("The Firebase Snapshot Worker must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Worker base URL must not contain credentials, query, or hash");
  }
  return parsed.href.replace(/\/$/, "");
}

export function createFirebaseSnapshotTransport({
  baseUrl,
  getIdToken,
  fetchImpl = globalThis.fetch,
  emptySnapshot
}) {
  const base = normalizeBaseUrl(baseUrl);
  if (typeof getIdToken !== "function") throw new Error("getIdToken must be a function");
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl must be a function");
  if (emptySnapshot !== undefined && !isRecord(emptySnapshot)) {
    throw new Error("emptySnapshot must be an object when supplied");
  }

  async function request(method, body, { metadata = false } = {}) {
    const token = await getIdToken();
    if (typeof token !== "string" || !token.trim()) {
      throw new Error("Firebase ID token is missing");
    }
    const endpoint = base + "/snapshot" + (metadata ? "?metadata=1" : "");
    const response = await fetchImpl(endpoint, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store"
    });
    let payload = {};
    const raw = await response.text();
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { throw Object.assign(new Error("Worker returned invalid JSON"), { status: response.status }); }
    if (!response.ok && response.status !== 409) {
      throw Object.assign(new Error(payload.error || ("Worker HTTP " + response.status)), {
        status: response.status, httpStatus: response.status, payload
      });
    }
    return { status: response.status, payload };
  }

  async function pullCloud() {
    const { status, payload } = await request("GET");
    if (status === 409) throw Object.assign(new Error(payload.error || "Unexpected conflict on cloud pull"), { status });
    let data;
    if (payload.exists === false || payload.data === "") {
      if (!emptySnapshot) throw new Error("Cloud snapshot does not exist; an explicit emptySnapshot is required");
      data = structuredClone(emptySnapshot);
    } else {
      if (typeof payload.data !== "string") throw new Error("Worker snapshot data must be a serialized JSON string");
      try { data = JSON.parse(payload.data); }
      catch { throw new Error("Worker snapshot data is not valid JSON"); }
    }
    if (!isRecord(data)) throw new Error("Worker snapshot must decode to an object");
    if (payload.revision !== null && typeof payload.revision !== "string") {
      throw new Error("Worker snapshot revision must be a string or null");
    }
    return { data, revision: payload.revision ?? null };
  }

  async function pushCloud({ data, baseRevision }) {
    if (!isRecord(data)) throw new Error("Cloud push data must be an object");
    if (baseRevision !== null && baseRevision !== undefined &&
        (typeof baseRevision !== "string" || !baseRevision.trim())) {
      throw new Error("baseRevision must be a non-empty string or null");
    }
    const { status, payload } = await request("POST", {
      data: JSON.stringify(data),
      revision: baseRevision ?? null
    });
    return {
      ...payload,
      status,
      ...(payload.revision !== undefined ? { revision: payload.revision } : {})
    };
  }

  async function pullMetadata() {
    const { status, payload } = await request("GET", null, { metadata: true });
    if (status === 409) throw Object.assign(new Error(payload.error || "Unexpected metadata conflict"), { status });
    if (payload.revision !== null && typeof payload.revision !== "string") {
      throw new Error("Worker metadata revision must be a string or null");
    }
    return { exists: payload.exists === true, revision: payload.revision ?? null };
  }

  return { pullCloud, pushCloud, pullMetadata };
}
