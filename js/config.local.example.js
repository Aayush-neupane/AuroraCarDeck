// Copy to config.local.js (same folder, never committed) and fill in:
//   window.AURORA_CONFIG = { authToken: 'pick-a-long-random-string' };
// The token MUST match AUTH_TOKEN in firmware secrets.h — the car drops
// drive links that don't present it.
window.AURORA_CONFIG = window.AURORA_CONFIG || {};
