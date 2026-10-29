#!/usr/bin/env node
// Owner tool, run with the owner's Wrangler login (no admin endpoint on the internet):
//   node scripts/code.mjs family|slot [--remote]   new manual code (Ko-fi, Satispay, PayPal, gifts)
//   node scripts/code.mjs recover <code> [--remote] licence link for the licence that code belongs to
// Without --remote it works on the local D1 used by `wrangler dev`. Add --test for the ar-test.gioxx.org copy.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { newCode, hashCode, normaliseCode } from '../src/codes.js';
import { randomToken, sha256Hex } from '../src/auth.js';

const LINK_TTL_MS = 30 * 60 * 1000;
const args = process.argv.slice(2);
const test = args.includes('--test');
const APP_ORIGIN = process.env.APP_ORIGIN || (test ? 'https://ar-test.gioxx.org' : 'https://ar.gioxx.org');
const DB_NAME = test ? 'andata-ritorno-test' : 'andata-ritorno';
const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const where = args.includes('--remote') ? '--remote' : '--local';
const [cmd, arg] = args.filter((a) => a !== '--remote' && a !== '--test');

/** Run one SQL statement through wrangler and return its result rows. Values are generated or hex-validated locally. */
function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB_NAME, where, '--config', 'wrangler.app.toml', ...(test ? ['--env', 'test'] : []), '--json', '--command', sql],
    { cwd: workerDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

function usage() {
  console.error('usage: node scripts/code.mjs family|slot [--remote] [--test]\n       node scripts/code.mjs recover <code> [--remote] [--test]');
  process.exit(2);
}

if (cmd === 'family' || cmd === 'slot') {
  const code = newCode();
  const hash = await hashCode(code);
  d1(`INSERT INTO codes (hash, kind, source, created_at) VALUES ('${hash}', '${cmd}', 'manual', '${new Date().toISOString()}')`);
  console.log(code);
} else if (cmd === 'recover') {
  const code = normaliseCode(arg);
  if (!code) usage();
  const [row] = d1(`SELECT licence_id FROM codes WHERE hash = '${await hashCode(code)}'`);
  if (!row) {
    console.error('Unknown code.');
    process.exit(1);
  }
  if (!row.licence_id) {
    console.error('This code has not been redeemed yet: it can still be redeemed as it is.');
    process.exit(1);
  }
  if (!/^[0-9a-f-]{36}$/.test(row.licence_id)) throw new Error(`unexpected licence id ${row.licence_id}`);
  const token = randomToken();
  const expires = new Date(Date.now() + LINK_TTL_MS).toISOString();
  d1(`INSERT INTO licence_links (hash, licence_id, expires_at) VALUES ('${await sha256Hex(token)}', '${row.licence_id}', '${expires}')`);
  console.log(`${APP_ORIGIN}/licence#${token}`);
  console.error(`Valid until ${expires}. Opening it starts a fresh family on the same licence.`);
} else {
  usage();
}
