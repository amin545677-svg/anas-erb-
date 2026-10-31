(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.window === root) {
    root.ANASReverseLedgerStagingClient = api;
    const config = root.ANAS_REVERSE_LEDGER_STAGING_CONFIG;
    if (config) {
      try {
        const client = api.initialize(config, {
          firebase: root.firebase,
          location: root.location
        });
        root.ANASReverseLedgerStagingAuth = client.auth;
        root.ANASReverseLedgerStagingApp = client.app;
        root.ANASReverseLedgerServer = client.gateway;
        const status = root.document && root.document.getElementById('anasFirebaseAuthStatus');
        if (status) {
          status.textContent = 'تم تهيئة بوابة الترحيل العكسي على مشروع Staging مع App Check. سجّل الدخول بحساب Staging قبل طلب الترحيل.';
        }
      } catch (error) {
        root.ANASReverseLedgerStagingError = error;
        const status = root.document && root.document.getElementById('anasFirebaseAuthStatus');
        if (status) status.textContent = 'بوابة الترحيل التجريبية غير مهيأة: ' + String(error && error.message || error);
        console.error('ANAS reverse-ledger staging initialization failed:', error);
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STAGING_PROJECT_ID = 'anas-erp-staging-a25e1';
  const APP_NAME = 'anas-erp-reverse-ledger-staging';
  const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

  function requiredText(value, label, maxLength) {
    if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
      throw new Error(label + ' is invalid');
    }
    return value.trim();
  }

  function validateConfig(config, location) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Dedicated staging configuration is required');
    }
    if (!config.firebaseConfig || config.firebaseConfig.projectId !== STAGING_PROJECT_ID) {
      throw new Error('Refusing to initialize reverse posting outside the dedicated staging Firebase project');
    }
    requiredText(config.firebaseConfig.apiKey, 'Firebase staging API key', 256);
    requiredText(config.firebaseConfig.appId, 'Firebase staging app ID', 256);
    requiredText(config.appCheckSiteKey, 'Staging App Check site key', 512);
    if (location && location.protocol !== 'https:' &&
        location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      throw new Error('Staging reverse posting requires HTTPS');
    }
    if (Array.isArray(config.allowedOrigins) && config.allowedOrigins.length) {
      if (!location || !config.allowedOrigins.includes(location.origin)) {
        throw new Error('This origin is not allowlisted for the staging reverse-ledger client');
      }
    } else {
      throw new Error('An explicit staging allowedOrigins list is required');
    }
    return config;
  }

  function normalizeCallableResult(data, expectedOperationId) {
    if (!data || data.ok !== true || data.operationId !== expectedOperationId ||
        !data.document || typeof data.document !== 'object' || Array.isArray(data.document) ||
        data.document.status !== 'POSTED' || !data.document.returnId) {
      throw new Error('The staging callable did not confirm this operation as POSTED');
    }
    return Object.freeze({ ok: true, operationId: data.operationId, document: data.document });
  }

  function initialize(config, dependencies) {
    const location = dependencies && dependencies.location;
    validateConfig(config, location);
    const firebase = dependencies && dependencies.firebase;
    if (!firebase || typeof firebase.initializeApp !== 'function' ||
        typeof firebase.appCheck !== 'function' || typeof firebase.functions !== 'function' ||
        typeof firebase.auth !== 'function') {
      throw new Error('Firebase App, Auth, App Check and Functions compat SDKs must be loaded');
    }

    function assertStagingApp(candidate, label) {
      if (!candidate || !candidate.options ||
          candidate.options.projectId !== STAGING_PROJECT_ID ||
          candidate.options.apiKey !== config.firebaseConfig.apiKey ||
          candidate.options.appId !== config.firebaseConfig.appId) {
        throw new Error(label + ' does not match the dedicated staging Firebase web app');
      }
      return candidate;
    }

    let app = null;
    // In the isolated staging build, the ERP's default Firebase app is already
    // initialized with the staging web config. Reuse it so the existing login
    // UI and the reverse-ledger callable share the exact same Auth session.
    // On production/default-app pages, never reuse that app: create or reuse a
    // separately named staging app, preserving the production Firebase session.
    try {
      const defaultApp = firebase.app();
      if (defaultApp && defaultApp.options &&
          defaultApp.options.projectId === STAGING_PROJECT_ID) {
        app = assertStagingApp(defaultApp, 'Default Firebase app');
      }
    } catch (_) {
      // No default app is initialized yet; continue with the isolated named app.
    }

    if (!app) {
      try {
        app = assertStagingApp(firebase.app(APP_NAME), 'Named Firebase app');
      } catch (error) {
        if (error && /does not match the dedicated staging Firebase web app/.test(error.message || '')) {
          throw error;
        }
        app = assertStagingApp(firebase.initializeApp(config.firebaseConfig, APP_NAME), 'New named Firebase app');
      }
    }

    const auth = firebase.auth(app);
    const appCheck = firebase.appCheck(app);
    appCheck.activate(config.appCheckSiteKey, true);
    const functions = firebase.functions(app, config.functionsRegion || 'us-central1');
    const callable = functions.httpsCallable('executeReverseLedger');

    const gateway = Object.freeze({
      execute: async function (request) {
        if (!auth.currentUser) throw new Error('Sign in to the dedicated Firebase staging account first');
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
          throw new Error('Reverse-ledger request must be an object');
        }
        if (typeof request.operationId !== 'string' || !OPERATION_ID.test(request.operationId)) {
          throw new Error('operationId format is invalid');
        }
        requiredText(request.periodId, 'periodId', 128);
        requiredText(request.invoiceId, 'invoiceId', 160);
        // Explicitly refresh the staging identity before invoking the callable.
        await auth.currentUser.getIdToken(true);
        const appCheckToken = await appCheck.getToken(false);
        if (!appCheckToken || typeof appCheckToken.token !== 'string' || !appCheckToken.token) {
          throw new Error('A valid staging App Check token is required');
        }
        const response = await callable(request);
        return normalizeCallableResult(response && response.data, request.operationId);
      }
    });

    return Object.freeze({ app, auth, appCheck, functions, gateway });
  }

  return Object.freeze({ initialize, validateConfig, normalizeCallableResult, stagingProjectId: STAGING_PROJECT_ID });
});
