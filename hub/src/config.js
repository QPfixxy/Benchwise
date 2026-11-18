'use strict';

// Configuration from the environment (on a server: /etc/benchwise-hub/hub.env,
// loaded by systemd). Secrets live there, never in the repository.

function loadConfig(env = process.env) {
  const listen = env.HUB_LISTEN || '127.0.0.1:8080';
  const [host, port] = listen.includes(':') ? [listen.slice(0, listen.lastIndexOf(':')), listen.slice(listen.lastIndexOf(':') + 1)] : ['127.0.0.1', listen];
  return {
    databaseUrl: env.HUB_DATABASE_URL,
    host,
    port: Number(port) || 8080,
    filesDir: env.HUB_FILES_DIR || '/var/lib/benchwise-hub/files',
    // Behind nginx: trust X-Forwarded-For from the local proxy only.
    trustProxy: env.HUB_TRUST_PROXY === '0' ? false : '127.0.0.1',
    // Cookies are Secure (HTTPS only) unless explicitly disabled for local testing.
    secureCookies: env.HUB_INSECURE_COOKIES !== '1',
    // Direct HTTPS (Windows, where there's no nginx in front): certificate and
    // key files. Unset on Ubuntu, where nginx terminates TLS.
    tlsCert: env.HUB_TLS_CERT || null,
    tlsKey: env.HUB_TLS_KEY || null,
    // With direct HTTPS: also listen on this port and redirect to HTTPS.
    httpRedirectPort: Number(env.HUB_HTTP_REDIRECT_PORT) || null,
    sessionHours: Math.min(Math.max(Number(env.HUB_SESSION_HOURS) || 12, 1), 168),
    maxUploadMb: Math.min(Math.max(Number(env.HUB_MAX_UPLOAD_MB) || 20, 1), 100),
  };
}

module.exports = { loadConfig };
