/**
 * Staging-only V42 runtime bootstrap.
 *
 * Installs the transactional mutation bridge only on the dedicated staging
 * Firebase Hosting origins. It does not auto-upload on boot; the user invokes
 * the separate operational sync action. Manual backup/restore functions remain
 * untouched.
 */
import {
  createMutationQueueOrchestrator,
  commitLocalMutation,
  recoverInterruptedLocalMutation,
  MUTATION_KEYS
} from "./mutation_queue_orchestrator.mjs";
import { createFirebaseSnapshotTransport } from "./firebase_snapshot_transport.mjs";
import { installV42RuntimeWiring } from "./v42_runtime_installer.mjs";
import { runV42PreparedRecovery } from "./v42-prepared-recovery-runtime.mjs";

const STAGING_HOSTS = new Set([
  "anas-erp-staging-a25e1.web.app",
  "anas-erp-staging-a25e1.firebaseapp.com"
]);
const STAGING_WORKER = "https://anas-erp-firebase-snapshot-staging.amin545677.workers.dev";

function makeStorageAdapter(resilient) {
  if (!resilient || typeof resilient.getItem !== "function" ||
      typeof resilient.setItem !== "function" || typeof resilient.removeSync !== "function") {
    throw new Error("ANAS_RESILIENT_STORAGE_UNAVAILABLE");
  }
  return {
    getItem(key) {
      const value = resilient.getItem(key);
      if (value == null) return null;
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    setItem(key, value) {
      let decoded;
      try { decoded = JSON.parse(String(value)); }
      catch { decoded = String(value); }
      const result = resilient.setItem(key, decoded);
      if (result && typeof result.catch === "function") {
        result.catch(error => {
          window.console?.error?.("[ANAS V42] mutation journal write failed:", error);
        });
      }
      return result;
    },
    removeItem(key) {
      return resilient.removeSync(key);
    },
    flush() {
      return typeof resilient.flushDurableItems === "function"
        ? resilient.flushDurableItems() : Promise.resolve();
    },
    getCommittedSnapshot() {
      return typeof resilient.getCommittedSnapshot === "function"
        ? resilient.getCommittedSnapshot() : null;
    }
  };
}

function waitForStorageReady(global) {
  const storage = global.ANASResilientStorage;
  if (!storage) return Promise.reject(new Error("ANAS_RESILIENT_STORAGE_UNAVAILABLE"));
  if (typeof storage.ready === "function" && storage.ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = null;
    const finish = (fn, value) => {
      if (timer !== null) clearTimeout(timer);
      global.removeEventListener("anas:storage-hydrated", onReady);
      fn(value);
    };
    const onReady = () => {
      if (typeof storage.ready === "function" && storage.ready()) finish(resolve);
      else finish(reject, new Error("ANAS_STORAGE_HYDRATION_NOT_READY"));
    };
    global.addEventListener("anas:storage-hydrated", onReady, { once: true });
    timer = setTimeout(() => finish(reject, new Error("ANAS_STORAGE_HYDRATION_TIMEOUT")), 20000);
  });
}

function workerBaseUrl(global) {
  let saved = "";
  try { saved = String(global.localStorage.getItem("ANAS_ERP_WORKER_URL") || "").trim(); }
  catch (_) {}
  const input = global.document?.getElementById("anasWorkerUrl");
  return saved || String(input?.value || "").trim() || STAGING_WORKER;
}

function mapV42Mutation({ entity, kind }) {
  if (kind === "sale") {
    const customerId = entity?.customerObj?.id ?? entity?.customerId ?? null;
    return {
      type: "SALE_INVOICE",
      payload: {
        customerId,
        warehouse: entity?.warehouse || entity?.warehouseName || "المخزن الرئيسي",
        invoice: structuredClone(entity)
      }
    };
  }
  if (kind === "collection") {
    return {
      type: "DEBT_COLLECTION",
      payload: {
        customerId: String(entity.referenceId),
        amount: Number(entity.amount),
        cashMovementId: String(entity.id),
        cashMovement: structuredClone(entity)
      }
    };
  }
  throw new Error("ANAS_V42_UNSUPPORTED_MUTATION_KIND:" + String(kind));
}

function statusMessage(status) {
  if (status?.code === "V42_SYNC_CONFLICT_RECONCILING") return "اكتُشف تعارض؛ تتم إعادة تسوية العمليات على أحدث نسخة سحابية…";
  if (status?.level === "success" && status?.result?.status === "synced") return "اكتملت المزامنة وتسوية التعارضات.";
  if (status?.level === "success" && status?.result?.status === "pushed") return "تم رفع لقطة البيانات وقبول رقم المراجعة السحابي.";
  if (status?.level === "warning" && status?.code === "V42_QUEUE_PROMOTION_DEFERRED") return "الحفظ المحلي مؤكد؛ تأجل ترحيل سجل المزامنة وسيُستعاد عند إعادة الفتح.";
  if (status?.code === "V42_UNSUPPORTED_LOCAL_MUTATIONS_PRESENT" ||
      status?.code === "V42_UNSUPPORTED_LOCAL_MUTATION_SAVED_LOCALLY") {
    return "حُفظت العملية محلياً، لكن المزامنة السحابية متوقفة لحماية البيانات حتى يُضاف دعم آمن لهذا النوع من العمليات.";
  }
  if (status?.level === "error") return "لم تكتمل المزامنة. بقيت العمليات محلياً للمراجعة أو إعادة المحاولة.";
  return "";
}

export async function installANASV42Runtime(global = window) {
  if (!STAGING_HOSTS.has(global.location?.hostname)) {
    return Object.freeze({ status: "skipped-non-staging-origin" });
  }
  if (global.__ANAS_DISABLE_V42_RUNTIME_BOOTSTRAP__ === true) {
    return Object.freeze({ status: "disabled-by-test-harness" });
  }
  if (global.__ANAS_V42_RUNTIME_INSTALL__) {
    return global.__ANAS_V42_RUNTIME_INSTALL__;
  }

  await waitForStorageReady(global);
  const recovery = await runV42PreparedRecovery(global);
  const resilient = global.ANASResilientStorage;
  const storage = makeStorageAdapter(resilient);
  const transport = createFirebaseSnapshotTransport({
    baseUrl: workerBaseUrl(global),
    getIdToken: async () => {
      if (typeof global.anasGetFirebaseIdToken !== "function") {
        throw new Error("FIREBASE_AUTH_SESSION_HELPER_UNAVAILABLE");
      }
      return global.anasGetFirebaseIdToken(8000);
    }
  });
  const orchestrator = createMutationQueueOrchestrator({
    storage,
    pullCloud: transport.pullCloud,
    pushCloud: transport.pushCloud
  });

  const installer = installV42RuntimeWiring({
    windowObject: global,
    storage,
    orchestrator,
    getAppData: () => {
      if (typeof AppData !== "undefined") return AppData;
      return global.AppData;
    },
    setAppData: value => {
      if (typeof AppData !== "undefined") AppData = value;
      global.AppData = value;
    },
    getSaveDB: () => global.saveDB,
    setSaveDB: fn => { global.saveDB = fn; },
    getSaveDBDurably: () => global.saveDBDurably,
    setSaveDBDurably: fn => { global.saveDBDurably = fn; },
    mapMutation: mapV42Mutation,
    uuid: () => {
      if (!global.crypto || typeof global.crypto.randomUUID !== "function") {
        throw new Error("CRYPTO_RANDOM_UUID_UNAVAILABLE");
      }
      return global.crypto.randomUUID();
    },
    onStatus: status => {
      global.__ANAS_V42_LAST_SYNC_STATUS__ = status;
      const node = global.document?.getElementById("anasFirebaseSyncStatus");
      if (node) node.textContent = statusMessage(status) || "حالة المزامنة: " + String(status?.level || "جاهز");
      global.dispatchEvent(new CustomEvent("anas:v42-sync-status", { detail: status }));
    },
    onQuarantine: items => {
      const node = global.document?.getElementById("anasFirebaseSyncStatus");
      if (node) node.textContent = "تم عزل " + items.length + " عملية مالية أو مخزنية للمراجعة؛ لم تُحذف.";
      global.dispatchEvent(new CustomEvent("anas:v42-sync-quarantine", { detail: items }));
    }
  });
  installer.install();

  const api = Object.freeze({
    status: "installed",
    recovery,
    push: () => global.anasFirebaseSyncPush(),
    pull: () => global.anasFirebaseSyncPull(),
    uninstall: () => installer.uninstall(),
    transport,
    orchestrator
  });
  global.ANASMutationQueue = Object.freeze({
    createMutationQueueOrchestrator,
    commitLocalMutation,
    recoverInterruptedLocalMutation,
    keys: MUTATION_KEYS
  });
  global.ANASMutationSync = api;
  global.__ANAS_V42_RUNTIME_INSTALL__ = api;

  const button = global.document?.getElementById("anasFirebaseSyncBtn");
  const statusNode = global.document?.getElementById("anasFirebaseSyncStatus");
  if (button) {
    button.disabled = false;
    if (!button.dataset.anasV42Bound) {
      button.dataset.anasV42Bound = "1";
      button.addEventListener("click", async () => {
        button.disabled = true;
        if (statusNode) statusNode.textContent = "جارٍ مزامنة العمليات مع السحابة…";
        try {
          const result = await global.anasFirebaseSyncPush();
          if (statusNode && result?.status === "pushed") statusNode.textContent = "تمت مزامنة بيانات الجهاز بنجاح.";
          else if (statusNode && result?.status === "synced") statusNode.textContent = "تمت المزامنة وإعادة تسوية التعارض بنجاح.";
          else if (statusNode) statusNode.textContent = "لم تكتمل المزامنة (" + String(result?.status || "unknown") + "). احتُفظ بالعمليات محلياً.";
        } catch (error) {
          if (statusNode) statusNode.textContent = "تعذرت المزامنة: " + String(error?.message || error);
          global.console?.error?.("[ANAS V42] sync action failed:", error);
        } finally {
          button.disabled = false;
        }
      });
    }
  }
  if (statusNode && !statusNode.textContent) {
    statusNode.textContent = "المزامنة جاهزة. لن تُرسل البيانات تلقائياً عند الإقلاع.";
  }
  return api;
}

if (typeof window !== "undefined" && window.document) {
  installANASV42Runtime(window).catch(error => {
    window.console?.error?.("[ANAS V42] runtime bootstrap deferred:", error);
    const node = window.document.getElementById("anasFirebaseSyncStatus");
    if (node) node.textContent = "المزامنة غير مهيأة: " + String(error?.message || error) + ". بقي العمل المحلي متاحاً.";
  });
}
