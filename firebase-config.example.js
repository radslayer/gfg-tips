// Rename this file to firebase-config.js and fill in the values from your
// NEW, SEPARATE Firebase project's console (Project settings -> General ->
// "Your apps" -> Web app -> SDK setup and configuration -> Config).
//
// Do NOT reuse the recipes.upshiftholdings.com project's config here --
// this is meant to be its own project (tips/payroll-adjacent data is more
// sensitive than recipes).
//
// This file is loaded by index.html as a plain <script> tag (not a module
// import), so it just needs to define window.FIREBASE_CONFIG.

window.FIREBASE_CONFIG = {
  apiKey: "PASTE_API_KEY_HERE",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};
