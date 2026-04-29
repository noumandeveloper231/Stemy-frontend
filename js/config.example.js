/**
 * Copy to config.js and adjust for your environment.
 * GOOGLE_CLIENT_ID: Web client ID from Google Cloud Console (public).
 * API_URL: must match where the Express API is served (include /api). Page origin must match server CORS + FRONTEND_URL (e.g. Live Server http://localhost:5500).
 * Deploy: point server FRONTEND_URL + email templates to pages/verify-email.html
 * and pages/reset-password.html (or equivalent routes) so verification and reset links work.
 */
window.STEMY_CONFIG = {
  API_URL: "http://localhost:3000/api",
  GOOGLE_CLIENT_ID: "YOUR_WEB_CLIENT_ID.apps.googleusercontent.com",
};
