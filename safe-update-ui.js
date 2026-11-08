/* ANAS ERP safe app-shell refresh. Never reads, clears, or rewrites application storage. */
(function () {
  'use strict';
  let activeAttempt = false;

  function setStatus(message, isError) {
    const status = document.getElementById('anasSafeUpdateStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#b91c1c' : 'var(--mp-text-muted, #475569)';
  }

  window.safeUpdateAppUI = async function safeUpdateAppUI() {
    if (activeAttempt) return;
    if (!('serviceWorker' in navigator)) {
      setStatus('تحديث الواجهة غير مدعوم في هذا المتصفح. بياناتك لم تتغير.', true);
      return;
    }
    activeAttempt = true;
    const button = document.getElementById('anasSafeUpdateButton');
    if (button) button.disabled = true;
    setStatus('جارٍ التحقق من تحديث الواجهة…');

    let registration;
    let installingWorker;
    let stateHandler;
    let controllerHandler;
    let timeoutId;
    let settled = false;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (installingWorker && stateHandler) installingWorker.removeEventListener('statechange', stateHandler);
      if (controllerHandler) navigator.serviceWorker.removeEventListener('controllerchange', controllerHandler);
    };
    const finish = (message, isError) => {
      if (settled) return;
      settled = true;
      cleanup();
      activeAttempt = false;
      if (button) button.disabled = false;
      setStatus(message, isError);
    };

    timeoutId = setTimeout(() => {
      finish('انتهت مهلة التحديث الآمن (6 ثوانٍ). لم نُعد تحميل الصفحة ولم نلمس بياناتك؛ أعد المحاولة لاحقاً.', true);
    }, 6000);

    try {
      registration = await navigator.serviceWorker.getRegistration('./');
      if (!registration) registration = await navigator.serviceWorker.register('./sw.js');
      await registration.update();

      const waiting = registration.waiting;
      installingWorker = registration.installing;
      if (!waiting && !installingWorker) {
        finish('الواجهة محدّثة بالفعل. لم تتغير بياناتك.', false);
        return;
      }

      const activateWhenReady = worker => {
        if (!worker || settled) return;
        if (worker.state === 'installed') {
          const waitingWorker = registration.waiting || worker;
          controllerHandler = () => {
            finish('تم تحديث الواجهة بنجاح. بياناتك المحلية محفوظة.', false);
            window.location.reload();
          };
          navigator.serviceWorker.addEventListener('controllerchange', controllerHandler, { once: true });
          waitingWorker.postMessage({ type: 'SKIP_WAITING' });
          return;
        }
        if (worker.state === 'redundant') {
          finish('تعذر تثبيت تحديث الواجهة. بياناتك لم تتغير؛ أعد المحاولة.', true);
        }
      };

      if (waiting) activateWhenReady(waiting);
      else if (installingWorker) {
        stateHandler = () => activateWhenReady(installingWorker);
        installingWorker.addEventListener('statechange', stateHandler);
        activateWhenReady(installingWorker);
      }
    } catch (error) {
      finish('تعذر تحديث الواجهة: ' + String(error && error.message || error) + '. بياناتك لم تتغير.', true);
    }
  };
})();
