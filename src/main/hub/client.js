'use strict';

// Talks to a Benchwise Hub. Two ways to trust the Hub's certificate:
//
//  - Pinned (a SHA-256 fingerprint is configured): for the Hub's self-signed
//    certificate. The TLS connection is opened and the certificate checked
//    BEFORE any byte of the request (including the station key) is sent.
//  - Otherwise the operating system's trusted certificates, through
//    Chromium's network stack (Electron net.fetch): a company certificate
//    installed on the PCs just works.

const tls = require('node:tls');
const https = require('node:https');
const net = require('node:net');

const normFp = (fp) => String(fp || '').replace(/[^0-9a-f]/gi, '').toUpperCase();

/** Pure: is this fingerprint well-formed (32 bytes of hex, any separators)? */
const validFingerprint = (fp) => normFp(fp).length === 64;

function pinnedRequest({ url, path, fingerprint, method, headers, body, timeoutMs }) {
  const u = new URL(url);
  const port = Number(u.port) || 443;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => {
      if (!settled) {
        settled = true;
        fn(v);
      }
    };
    const socket = tls.connect({
      host: u.hostname,
      port,
      servername: net.isIP(u.hostname) ? undefined : u.hostname,
      rejectUnauthorized: false, // we check the pinned fingerprint ourselves, below
      timeout: timeoutMs,
    });
    socket.once('timeout', () => {
      socket.destroy();
      done(reject, new Error('Connection to the Hub timed out.'));
    });
    socket.once('error', (err) => done(reject, err));
    socket.once('secureConnect', () => {
      const got = normFp(socket.getPeerCertificate()?.fingerprint256);
      if (got !== normFp(fingerprint)) {
        socket.destroy();
        return done(reject, Object.assign(new Error("The Hub's certificate doesn't match the configured fingerprint."), { code: 'CERT_MISMATCH' }));
      }
      const req = https.request(
        { host: u.hostname, port, path: `${u.pathname.replace(/\/$/, '')}${path}`, method, headers, createConnection: () => socket, timeout: timeoutMs },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => done(resolve, { status: res.statusCode, text: data }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('The Hub did not answer in time.')));
      req.on('error', (err) => done(reject, err));
      req.end(body);
    });
  });
}

/**
 * One request to the Hub. Resolves { status, json } for any HTTP answer;
 * rejects only when the Hub couldn't be reached (or isn't who it should be).
 */
async function hubRequest({ url, key, fingerprint, method = 'GET', path, body, timeoutMs = 30000, netFetch }) {
  if (!/^https:\/\//i.test(url || '')) throw new Error('The Hub address must start with https://');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    authorization: `Bearer ${key}`,
    accept: 'application/json',
    ...(payload ? { 'content-type': 'application/json' } : {}),
  };
  let res;
  if (fingerprint) {
    const length = payload ? { 'content-length': Buffer.byteLength(payload) } : {};
    res = await pinnedRequest({ url, path, fingerprint, method, headers: { ...headers, ...length }, body: payload, timeoutMs });
  } else {
    const signal = AbortSignal.timeout(timeoutMs);
    const r = await netFetch(`${url.replace(/\/$/, '')}${path}`, { method, headers, body: payload, signal });
    res = { status: r.status, text: await r.text() };
  }
  let json = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

module.exports = { hubRequest, validFingerprint, normFp };
