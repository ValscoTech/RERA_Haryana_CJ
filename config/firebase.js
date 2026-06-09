// config/firebase.js
// Uses Firebase Emulator when USE_EMULATOR=true (for testing)
// Falls back to real service account for production
require("dotenv").config();
const admin = require("firebase-admin");

if (process.env.USE_EMULATOR === "true") {
  admin.initializeApp({ projectId: "demo-haryana-rera" });

  const db = admin.firestore();
  db.settings({
    host: process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080",
    ssl: false,
  });

  module.exports = db;
} else {
  const path = require("path");
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      console.error("[HR-CJ] Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable:", err);
      throw err;
    }
  } else {
    // Try multiple paths to find serviceAccountKey.json:
    // 1. Current config folder: ./serviceAccountKey.json
    // 2. Project root: ../serviceAccountKey.json
    // 3. Workspace root (two levels up): ../../serviceAccountKey.json
    const searchPaths = [
      path.join(__dirname, "serviceAccountKey.json"),
      path.join(__dirname, "..", "serviceAccountKey.json"),
      path.join(__dirname, "..", "..", "serviceAccountKey.json")
    ];

    let lastError;
    for (const p of searchPaths) {
      try {
        serviceAccount = require(p);
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!serviceAccount) {
      console.error("[HR-CJ] Could not load serviceAccountKey.json from any of the search paths:", searchPaths);
      throw lastError;
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  module.exports = admin.firestore();
}
