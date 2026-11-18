'use strict';

// Configuration from the environment (on a server: /etc/benchwise-server/server.env,
// loaded by systemd). Secrets live there, never in the repository.

const hostPort = (v, fallbackPort) => {
  const i = v.lastIndexOf(':');
  return i > 0 ? { host: v.slice(0, i), port: Number(v.slice(i + 1)) || fallbackPort } : { host: '127.0.0.1', port: Number(v) || fallbackPort };
};

function loadConfig(env = process.env) {
  const { host, port } = hostPort(env.BW_LISTEN || '127.0.0.1:8080', 8080);
  return {
    // site (one facility; the first role built) or hub (central; later phase).
    role: env.BW_ROLE === 'hub' ? 'hub' : 'site',
    // Floor (test network) side: station uploads only. Unset = one network:
    // everything on BW_LISTEN.
    floor: env.BW_FLOOR_LISTEN ? hostPort(env.BW_FLOOR_LISTEN, 8081) : null,
    databaseUrl: env.BW_DATABASE_URL,
    host,
    port,
    // Behind nginx: trust X-Forwarded-For from the local proxy only.
    trustProxy: env.BW_TRUST_PROXY === '0' ? false : '127.0.0.1',
    // Cookies are Secure (HTTPS only) unless explicitly disabled for local testing.
    secureCookies: env.BW_INSECURE_COOKIES !== '1',
    // Direct HTTPS (Windows, where there's no nginx in front): certificate and
    // key files. Unset on Ubuntu, where nginx terminates TLS.
    tlsCert: env.BW_TLS_CERT || null,
    tlsKey: env.BW_TLS_KEY || null,
    // With direct HTTPS: also listen on this port and redirect to HTTPS.
    httpRedirectPort: Number(env.BW_HTTP_REDIRECT_PORT) || null,
    // Setup wizard: where the root helper picks up requests and reports back,
    // and the certificate whose fingerprint the wizard shows.
    requestsDir: env.BW_REQUESTS_DIR || '/var/lib/benchwise-server/requests',
    statusDir: env.BW_STATUS_DIR || '/var/lib/benchwise-server/status',
    // The Benchwise build that sticks get (app.zip), kept by the server.
    sticksDir: env.BW_STICKS_DIR || '/var/lib/benchwise-server/sticks',
    releasesRepo: env.BW_RELEASES_REPO || 'QPfixxy/Benchwise',
    certPath: env.BW_CERT_PATH || '/etc/benchwise-server/tls/server.crt',
    sessionHours: Math.min(Math.max(Number(env.BW_SESSION_HOURS) || 12, 1), 168),
    maxUploadMb: Math.min(Math.max(Number(env.BW_MAX_UPLOAD_MB) || 5, 1), 50),
  };
}

module.exports = { loadConfig };
