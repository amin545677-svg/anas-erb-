import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';

// Expose the same compat namespace expected by the legacy ERP shell.
// The SDK code itself is bundled into the local PWA; no SDK CDN is needed.
globalThis.firebase = firebase;
