(function (g) {
  'use strict';
  if (g.__ANAS_LIVE_DURABILITY_STATUS_R40__) return;
  g.__ANAS_LIVE_DURABILITY_STATUS_R40__ = true;
  function bar() { return g.document && g.document.getElementById('anas-live-status-bar'); }
  function emit(type, detail) {
    if (!g.document || typeof g.CustomEvent !== 'function') return;
    try { g.document.dispatchEvent(new g.CustomEvent(type, { detail: detail || {} })); } catch (_) {}
  }
  function network(forced) {
    const b = bar(); if (!b) return;
    const online = typeof forced === 'boolean' ? forced : (!g.navigator || g.navigator.onLine !== false);
    b.dataset.networkState = online ? 'online' : 'offline';
    const badge = g.document.getElementById('anas-status-network-badge');
    if (badge) badge.textContent = online ? '● متصل' : '● غير متصل';
  }
  function durability(state, label) {
    const b = bar(); if (!b) return;
    b.dataset.durabilityState = state;
    const badge = g.document.getElementById('anas-status-durability-badge');
    if (badge) badge.textContent = label;
  }
  function syncLiveDurabilityStatusBar() {
    if (!bar()) return false;
    const storage = g.ANASResilientStorage, data = g.AppData;
    if (!storage || typeof storage.getCommittedSnapshot !== 'function' ||
        typeof storage.canonicalizeJson !== 'function' || !data ||
        (typeof storage.ready === 'function' && !storage.ready())) {
      durability('uncommitted', '⚠ غير محفوظ'); return false;
    }
    try {
      const committed = storage.getCommittedSnapshot();
      const matches = !!committed &&
        storage.canonicalizeJson(committed) === storage.canonicalizeJson(data);
      durability(matches ? 'committed' : 'uncommitted',
        matches ? '✓ محفوظ بأمان' : '⚠ توجد تغييرات غير محفوظة');
      return matches;
    } catch (_) {
      durability('uncommitted', '⚠ تعذر التحقق من الحفظ'); return false;
    }
  }
  g.syncLiveDurabilityStatusBar = syncLiveDurabilityStatusBar;
  function hookDurableSave() {
    if (typeof g.saveDBDurably !== 'function' || g.saveDBDurably.__anasR40Wrapped) return false;
    const original = g.saveDBDurably;
    const wrapped = async function () {
      durability('saving', '… جارٍ الحفظ'); emit('anas:durability-saving');
      try {
        const result = await original.apply(this, arguments);
        if (result === true) {
          const committed = syncLiveDurabilityStatusBar();
          emit(committed ? 'anas:durability-committed' : 'anas:durability-uncommitted');
        } else {
          durability('uncommitted', '⚠ لم يكتمل الحفظ'); emit('anas:durability-uncommitted');
        }
        return result;
      } catch (error) {
        durability('uncommitted', '⚠ فشل الحفظ');
        emit('anas:durability-failed', { message: String(error && error.message || error) });
        throw error;
      }
    };
    wrapped.__anasR40Wrapped = true; g.saveDBDurably = wrapped; return true;
  }
  network();
  g.addEventListener('online', function () { network(true); });
  g.addEventListener('offline', function () { network(false); });
  g.document.addEventListener('anas:storage-hydrated', function () {
    hookDurableSave(); syncLiveDurabilityStatusBar();
  });
  g.document.addEventListener('anas:storage-committed', syncLiveDurabilityStatusBar);
  g.document.addEventListener('anas:appdata-updated', syncLiveDurabilityStatusBar);
  g.document.addEventListener('anas:pos-cart-updated', syncLiveDurabilityStatusBar);
  hookDurableSave(); syncLiveDurabilityStatusBar();
})(window);
