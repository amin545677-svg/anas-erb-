// Copy this file to config.js in the dedicated staging deployment.
// These are Firebase Web App and App Check public identifiers, not service-account secrets.
window.ANAS_REVERSE_LEDGER_STAGING_CONFIG = {
  firebaseConfig: {
    apiKey: "REPLACE_WITH_STAGING_WEB_API_KEY",
    authDomain: "anas-erp-staging-a25e1.firebaseapp.com",
    projectId: "anas-erp-staging-a25e1",
    appId: "REPLACE_WITH_STAGING_WEB_APP_ID"
  },
  appCheckSiteKey: "REPLACE_WITH_STAGING_RECAPTCHA_V3_SITE_KEY",
  allowedOrigins: ["https://REPLACE_WITH_STAGING_HOST"],
  functionsRegion: "us-central1"
};
