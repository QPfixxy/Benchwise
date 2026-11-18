#!/usr/bin/env node
'use strict';

// Server-side administration. Run on the Hub server, e.g.:
//   sudo benchwise-hub migrate
//   sudo benchwise-hub create-admin alice
//   sudo benchwise-hub create-site DAL "Dallas"
//   sudo benchwise-hub create-station DAL "Bench 1"
//   sudo benchwise-hub verify DAL
//
// `migrate` needs the schema owner's connection (HUB_OWNER_DATABASE_URL);
// everything else uses the service's (HUB_DATABASE_URL).

const crypto = require('node:crypto');
const { createPool, migrate } = require('./db');
const { newKey } = require('./keys');
const { hashPassword } = require('./passwords');
const { verifyChain, log } = require('./store');

const USAGE = `Usage: benchwise-hub <command>
  migrate                         apply database migrations (as the schema owner)
  create-admin <username>         create an administrator; prints a generated password once
  create-site <CODE> <name>       add a facility (CODE: 2-16 letters, digits, dashes)
  create-station <CODE> <name>    enroll a station at a site; prints its key once
  verify <CODE>                   check a site's tamper-evidence chain`;

async function main([cmd, ...args]) {
  if (cmd === 'migrate') {
    const pool = createPool(process.env.HUB_OWNER_DATABASE_URL || process.env.HUB_DATABASE_URL, { max: 1 });
    try {
      const applied = await migrate(pool, { log: (m) => console.log(m) });
      console.log(applied.length ? `${applied.length} migration(s) applied.` : 'Database is up to date.');
    } finally {
      await pool.end();
    }
    return;
  }
  const pool = createPool(process.env.HUB_DATABASE_URL, { max: 1 });
  try {
    switch (cmd) {
      case 'create-admin': {
        const [username] = args;
        if (!/^[a-z0-9._-]{3,40}$/.test(username || '')) throw new Error('Username: 3-40 lowercase letters, digits, dot, dash or underscore.');
        // A generated password: 24 characters from ~190 bits of randomness.
        const password = crypto.randomBytes(24).toString('base64url').slice(0, 24);
        await pool.query('INSERT INTO users (username, password_hash, role, all_sites) VALUES ($1, $2, $3, true)', [username, await hashPassword(password), 'admin']);
        await log(pool, 'cli', 'user.create', { username, role: 'admin' });
        console.log(`Administrator "${username}" created.\nPassword (shown once, store it safely): ${password}`);
        break;
      }
      case 'create-site': {
        const [code, ...name] = args;
        if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,15}$/.test(code || '') || !name.length) throw new Error('Usage: create-site <CODE> <name>');
        await pool.query('INSERT INTO sites (code, name) VALUES (upper($1), $2)', [code, name.join(' ')]);
        await log(pool, 'cli', 'site.create', { code: code.toUpperCase(), name: name.join(' ') });
        console.log(`Site ${code.toUpperCase()} created.`);
        break;
      }
      case 'create-station': {
        const [code, ...name] = args;
        const site = (await pool.query('SELECT id, code FROM sites WHERE code = upper($1)', [code || ''])).rows[0];
        if (!site || !name.length) throw new Error(site ? 'Usage: create-station <CODE> <name>' : `No site ${code}.`);
        const { key, prefix, hash } = newKey('station');
        await pool.query('INSERT INTO stations (site_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)', [site.id, name.join(' '), prefix, hash]);
        await log(pool, 'cli', 'station.create', { site: site.code, name: name.join(' '), keyPrefix: prefix });
        console.log(`Station "${name.join(' ')}" enrolled at ${site.code}.\nKey (shown once): ${key}`);
        break;
      }
      case 'verify': {
        const site = (await pool.query('SELECT id, code FROM sites WHERE code = upper($1)', [args[0] || ''])).rows[0];
        if (!site) throw new Error(`No site ${args[0]}.`);
        const r = await verifyChain(pool, site.id);
        console.log(r.ok ? `${site.code}: chain intact (${r.checked} audits).` : `${site.code}: CHAIN BROKEN at audit ${r.brokenAt} (${r.reason}).`);
        if (!r.ok) process.exitCode = 2;
        break;
      }
      default:
        console.log(USAGE);
        if (cmd) process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.code === '23505' ? 'Already exists.' : err.message);
  process.exit(1);
});
