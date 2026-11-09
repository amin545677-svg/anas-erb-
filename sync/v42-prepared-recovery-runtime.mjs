/**
 * Boot-time recovery for interrupted PREPARED mutation intents.
 *
 * This is deliberately limited to journal recovery. It does not install cloud
 * sync or replace V42 saveDB; the existing AppData snapshot remains authoritative.
 */
import { recoverPreparedMutationsOnBoot } from "./v42_transactional_bridge.mjs";
import { MUTATION_KEYS } from "./mutation_keys.mjs";

const STORAGE_KEY = "__ANAS_V42_PREPARED_RECOVERY_V1__";

function makeRecoveryStorage(storage) {
  return {
    getItem(key) {
      const value = storage.getItem(key);
      if (value == null) return null;
      // The resilient adapter returns decoded objects for AppData and strings
      // for journal entries. The recovery helper consumes a JSON-compatible view.
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    setItem(key, value) {
      storage.setItem(key, String(value));
    },
    removeItem(key) {
      storage.removeSync(key);
    }
  };
}

export async function runV42PreparedRecovery(global = window) {
  if (global[STORAGE_KEY]) return global[STORAGE_KEY];
  const task = (async () => {
    const storage = global.ANASResilientStorage;
    if (!storage || typeof storage.hydrate !== "function" ||
        typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      throw new Error("ANAS_RESILIENT_STORAGE_UNAVAILABLE");
    }

    // Join the same hydration barrier used by the ERP shell before reading AppData.
    await storage.hydrate();
    if (typeof storage.ready === "function" && !storage.ready()) {
      throw new Error("ANAS_RESILIENT_STORAGE_NOT_READY");
    }

    const persistedAppData = storage.getItem(MUTATION_KEYS.appData);
    if (persistedAppData == null) {
      const rawQueue = storage.getItem(MUTATION_KEYS.pending);
      const queue = rawQueue == null || rawQueue === ""
        ? []
        : JSON.parse(typeof rawQueue === "string" ? rawQueue : JSON.stringify(rawQueue));
      if (!Array.isArray(queue)) throw new Error("ANAS_PENDING_MUTATION_QUEUE_INVALID");
      const remainingPrepared = queue.filter(item => item?.status === "PREPARED").length;
      // Fresh installs and isolated UI tests may not have an AppData snapshot yet.
      // Never report that as a boot failure or mutate a journal without its proof.
      return Object.freeze({
        status: remainingPrepared ? "deferred-missing-appdata" : "skipped-no-appdata",
        recovered: 0,
        aborted: 0,
        remainingPrepared
      });
    }

    const adapter = makeRecoveryStorage(storage);
    const result = recoverPreparedMutationsOnBoot(adapter);
    if (result.remainingPrepared !== 0) {
      throw new Error("ANAS_PREPARED_MUTATIONS_REMAIN:" + result.remainingPrepared);
    }
    return Object.freeze({
      status: "recovered",
      recovered: result.recovered.length,
      aborted: result.aborted.length,
      remainingPrepared: result.remainingPrepared
    });
  })();
  global[STORAGE_KEY] = task;
  try {
    return await task;
  } catch (error) {
    // Permit a later explicit retry, but never block the ERP boot sequence.
    delete global[STORAGE_KEY];
    throw error;
  }
}

function scheduleRecovery(global) {
  const run = () => {
    runV42PreparedRecovery(global).then(result => {
      global.dispatchEvent(new CustomEvent("anas:v42-prepared-recovery", { detail: result }));
    }).catch(error => {
      // Isolated, visible diagnostic only; business data and startup remain untouched.
      global.console?.error?.("[ANAS V42] PREPARED recovery deferred:", error);
      global.dispatchEvent(new CustomEvent("anas:v42-prepared-recovery-error", {
        detail: { code: error?.message || "PREPARED_RECOVERY_FAILED" }
      }));
    });
  };
  if (global.document.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
}

if (typeof window !== "undefined" && window.document) scheduleRecovery(window);
