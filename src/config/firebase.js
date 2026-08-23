const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

let initialized = false;

function ensureApp() {
  if (initialized || getApps().length) {
    initialized = true;
    return;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.warn(
      '[firebase] FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled.'
    );
    return;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    console.error('[firebase] FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
    return;
  }

  initializeApp({ credential: cert(serviceAccount) });
  initialized = true;
}

module.exports = {
  // Returns a Firebase messaging instance, or null if Firebase is not configured.
  getMessaging: () => {
    ensureApp();
    if (!initialized) return null;
    return getMessaging();
  },
};