/**
 * Stemy client configuration (safe to commit — no secrets).
 * Override per machine: load another script before main.js that sets window.STEMY_CONFIG,
 * or edit values below (use the same Web client ID as server GOOGLE_CLIENT_ID for Google login).
 */
window.STEMY_CONFIG = Object.assign(
  {
    API_URL: "https://stemy-backend.onrender.com/api",
    GOOGLE_CLIENT_ID: "422382686287-k6bgl7hjjfjsrfsob71a7aql3jkvu6l2.apps.googleusercontent.com",
  },
  window.STEMY_CONFIG || {},
);
