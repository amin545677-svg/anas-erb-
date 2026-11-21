/**
 * Firestore REST read/write transaction runner for Cloudflare Workers.
 * The callback is re-executed from its first read on every ABORTED retry.
 */
function firestoreError(result, operation) {
  const status = result?.data?.error?.status || result?.data?.error?.code ||
    (result?.response?.status ? String(result.response.status) : "UNKNOWN");
  const message = result?.data?.error?.message || `Firestore ${operation} failed (${status})`;
  const error = new Error(message);
  error.code = status;
  error.httpStatus = result?.response?.status ?? null;
  error.operation = operation;
  return error;
}

export async function runFirestoreRestTransaction(adapter, transactionWork, options = {}) {
  if (!adapter || typeof adapter.beginTransaction !== "function" ||
      typeof adapter.readDocument !== "function" ||
      typeof adapter.commitTransaction !== "function" ||
      typeof adapter.rollbackTransaction !== "function") {
    throw new TypeError("Firestore REST transaction adapter is incomplete");
  }
  if (typeof transactionWork !== "function") throw new TypeError("transaction work callback is required");
  const maxAttempts = options.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new RangeError("maxAttempts must be an integer from 1 through 5");
  }

  let lastAbort;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let transaction = null;
    let committed = false;
    try {
      transaction = await adapter.beginTransaction();
      const context = Object.freeze({
        transaction,
        attempt,
        get: path => adapter.readDocument(path, transaction)
      });
      // All reads and validation are rerun from the beginning on each attempt.
      const prepared = await transactionWork(context);
      if (!prepared || !Array.isArray(prepared.writes)) {
        throw new TypeError("transaction work must return a writes array");
      }
      const result = await adapter.commitTransaction(transaction, prepared.writes);
      if (!result?.response?.ok) throw firestoreError(result, "commit");
      committed = true;
      return prepared.result;
    } catch (error) {
      if (!committed && transaction !== null) {
        try { await adapter.rollbackTransaction(transaction); } catch { /* preserve original failure */ }
      }
      if (error?.code === "ABORTED") {
        lastAbort = error;
        if (attempt < maxAttempts) continue;
        const exhausted = new Error(`Firestore transaction aborted after ${maxAttempts} attempts`);
        exhausted.code = "ABORTED";
        exhausted.attempts = maxAttempts;
        exhausted.cause = lastAbort;
        throw exhausted;
      }
      throw error;
    }
  }
  throw lastAbort || new Error("Firestore transaction failed");
}
