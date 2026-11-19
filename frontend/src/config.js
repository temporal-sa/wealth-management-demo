// The API, on the web UI's own origin. The React dev server proxies /api to the API (package.json's
// "proxy", http://127.0.0.1:8000), so the browser sends the API's session cookie with every call.
export const API_BASE_URL = '/api';
