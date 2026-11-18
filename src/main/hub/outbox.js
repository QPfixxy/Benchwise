'use strict';

// The outbox: every saved report is queued here and sent to the Benchwise Hub
// in the background. Saving never waits for the network: a unit can be
// tested and shut down with the server unreachable; the stick catches up later.
//
//   <data>/outbox/pending/<id>.json   waiting to be sent ({ record })
//   <data>/outbox/sent/<id>.json      accepted by the server (pruned after 30 days)
//   <data>/outbox/failed/<id>.json    refused for good (+ <id>.reason.txt)
//
// Hub answers:  201/200 sent · 400/409/413 refused (kept, never retried)
//               401/403 key problem · 429/5xx/no network: retry with back-off

const fs = require('node:fs/promises');
const path = require('node:path');

const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const KEEP_SENT_DAYS = 30;

class Outbox {
  /**
   * @param {object} o
   * @param {string} o.dir           the outbox folder
   * @param {() => object|null} o.config   { url, key, fingerprint } or null when no Hub is set up
   * @param {(cfg, body) => Promise<{status, json}>} o.send
   */
  constructor({ dir, config, send, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} }) {
    Object.assign(this, { dir, config, send, now, setTimer, clearTimer, onChange });
    this.retryMs = 0;
    this.timer = null;
    this.running = null;
    this.last = { sentAt: null, error: null, nextAttemptAt: null };
  }

  #p = (...xs) => path.join(this.dir, ...xs);

  async #list(sub) {
    try {
      return (await fs.readdir(this.#p(sub))).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  /** Queues one saved record. Atomic: a half-written file is never sent. */
  async enqueue(record) {
    await fs.mkdir(this.#p('pending'), { recursive: true });
    const file = this.#p('pending', `${record.id}.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ queuedAt: new Date(this.now()).toISOString(), record }));
    await fs.rename(tmp, file);
    this.kick();
  }

  async status() {
    const cfg = this.config();
    return {
      configured: Boolean(cfg),
      pending: (await this.#list('pending')).length,
      failed: (await this.#list('failed')).length,
      ...this.last,
    };
  }

  /** Try now (cancels any back-off wait). */
  kick() {
    this.clearTimer(this.timer);
    this.timer = null;
    this.retryMs = 0;
    this.flush().catch(() => {});
  }

  /** Sends everything pending, oldest first. One run at a time. */
  flush() {
    this.running ??= this.#run().finally(() => (this.running = null));
    return this.running;
  }

  async #run() {
    const cfg = this.config();
    if (!cfg) return;
    const files = [];
    for (const f of await this.#list('pending')) {
      const st = await fs.stat(this.#p('pending', f)).catch(() => null);
      if (st) files.push([st.mtimeMs, f]);
    }
    files.sort((a, b) => a[0] - b[0]);
    for (const [, f] of files) {
      let body;
      try {
        body = JSON.parse(await fs.readFile(this.#p('pending', f), 'utf8'));
      } catch {
        await this.#park(f, 'failed', 'The queued file is unreadable.');
        continue;
      }
      let res;
      try {
        res = await this.send(cfg, { record: body.record });
      } catch (err) {
        return this.#retryLater(err.code === 'CERT_MISMATCH' ? err.message : `Server unreachable: ${err.message}`);
      }
      if (res.status === 200 || res.status === 201) {
        await this.#park(f, 'sent');
        this.last = { sentAt: new Date(this.now()).toISOString(), error: null, nextAttemptAt: null };
        this.onChange();
      } else if ([400, 409, 413, 422].includes(res.status)) {
        await this.#park(f, 'failed', `${res.status}: ${res.json?.error || 'refused by the server'}`);
        this.last.error = `A report was refused by the server (${res.status}: ${res.json?.error || 'refused'}).`;
        this.onChange();
      } else if (res.status === 401 || res.status === 403) {
        return this.#retryLater('The server rejected this station key. Check the key in Settings (or site.cmd).');
      } else {
        return this.#retryLater(`The server answered ${res.status}; will retry.`);
      }
    }
    this.retryMs = 0;
    await this.#pruneSent();
  }

  #retryLater(error) {
    this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : RETRY_MIN_MS, RETRY_MAX_MS);
    this.last = { ...this.last, error, nextAttemptAt: new Date(this.now() + this.retryMs).toISOString() };
    this.onChange();
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.retryMs);
    this.timer?.unref?.();
  }

  async #park(file, where, reason) {
    await fs.mkdir(this.#p(where), { recursive: true });
    await fs.rename(this.#p('pending', file), this.#p(where, file));
    if (reason) await fs.writeFile(this.#p(where, file.replace(/\.json$/, '.reason.txt')), `${reason}\n`);
  }

  async #pruneSent() {
    const cutoff = this.now() - KEEP_SENT_DAYS * 86_400_000;
    for (const f of await this.#list('sent')) {
      const st = await fs.stat(this.#p('sent', f)).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.rm(this.#p('sent', f), { force: true });
    }
  }

  stop() {
    this.clearTimer(this.timer);
    this.timer = null;
  }
}

module.exports = { Outbox, RETRY_MIN_MS, RETRY_MAX_MS };
