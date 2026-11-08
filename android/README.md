# ANAS ERP — Android biometric build (separate from the website)

This Android project is deliberately isolated under `android/`. It does not change or publish the existing GitHub Pages website, Firebase Worker, or AI Worker.

## Implemented in this branch
- Native AndroidX BiometricPrompt gate before showing the ERP.
- Uses a strong enrolled biometric (fingerprint where supported) with Android device credential as the system fallback.
- Re-locks the app when it leaves the foreground; the session is never persisted as unlocked.
- Sets `FLAG_SECURE` to block screenshots/recents previews, disables Android backup, cleartext traffic, WebView file access and mixed content.
- Restricts top-level WebView navigation to the official GitHub Pages host.
- Replaces the WebView `localStorage` API at document start with a native store whose values are AES-256-GCM encrypted using a non-exportable Android Keystore key. The app fails closed if document-start script support or storage validation is unavailable.
- Does not store a fingerprint image/template; Android handles biometric matching.

## Important limitations before production
- The hosted website remains the existing web release. This native wrapper does not itself make Firebase Google sign-in compatible with embedded WebView. Validate cloud authentication on a physical device; a native Firebase Auth integration or trusted browser auth flow may be required.
- WebView local data in this Android package is encrypted by this native adapter, but data already stored by the standalone website in its browser profile is separate and is not migrated automatically.
- A failed Android Keystore key or corrupted ciphertext intentionally blocks app startup rather than silently wiping business data. Recovery must use a known-good export/backup; reinstalling can make the old encrypted data unrecoverable.
- Automated CI can compile and run pure unit tests, but cannot prove fingerprint sensor behavior, biometric enrollment, encryption on a real device, cloud login, or data migration. These require physical-device acceptance tests.
- Do not publish a release APK until the CI checks pass and the physical-device checklist below is completed.

## Physical-device acceptance checklist
1. Test on a device with an enrolled fingerprint: first launch must request system biometric authentication.
2. Cancel authentication: no ERP data must become visible.
3. Fail the biometric repeatedly: the ERP must remain locked.
4. Background the app and return: biometric/device-credential authentication must be required.
5. Save a test product, fully close/reopen the app, authenticate, and verify the product remains.
6. Confirm ciphertext is stored in app preferences rather than raw ERP JSON.
7. Confirm screenshots/recents previews are blocked.
8. Test a test account's Firebase sign-in and backup/restore; do not use production business data.
9. Test a backup/export before any update; do not uninstall during testing because the Android Keystore key may be lost.

## Build
Open the `android/` folder in Android Studio with JDK 17 and Android SDK 35, or run:
`gradle testDebugUnitTest assembleDebug`
