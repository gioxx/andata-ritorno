import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';
import schema from '../schema.sql?raw';

// Apply the production schema to the test D1 database once per test file.
beforeAll(async () => {
  const statements = schema
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
});
