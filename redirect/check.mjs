// Self-check for the redirect Worker: node redirect/check.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import w, { KILL_SWITCH } from './src/index.js';

const f = (u) => w.fetch(new Request(u));
let r = await f('https://ar.gioxx.org/sw.js');
assert.equal(r.status, 200);
assert.equal(await r.text(), KILL_SWITCH);
r = await f('https://ar.gioxx.org/x?y=1');
assert.equal(r.status, 301);
assert.equal(r.headers.get('location'), 'https://ar.gxware.org/x?y=1');
assert.equal((await f('https://constructor/')).status, 404);
const landing = readFileSync(new URL('../landing/public/sw.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
assert.ok(landing.endsWith(KILL_SWITCH), 'kill switch drifted from landing/public/sw.js');
console.log('redirect ok');
