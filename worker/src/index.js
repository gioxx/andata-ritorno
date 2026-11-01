import { HttpError, json, limited, route } from './http.js';
import { familyRoutes } from './family.js';
import { licenceRoutes } from './licence.js';
import { syncRoutes } from './sync.js';
import { photoRoutes } from './photos.js';
import { adminRoutes } from './admin.js';
import { publicRoutes } from './public.js';

// Later tasks add routes here as 'METHOD /api/path/:param': async (req, env, ctx, params) => Response.
export const routes = { ...licenceRoutes, ...familyRoutes, ...syncRoutes, ...photoRoutes, ...adminRoutes, ...publicRoutes };

// Routes a device calls with its token: limited per device (requireApiDevice), never per IP. A
// first sync sends one request per photo, and a whole family may sit behind one home IP.
const deviceRoutes = new Set([
  ...Object.values(syncRoutes),
  ...Object.values(photoRoutes),
  familyRoutes['GET /api/family'],
  familyRoutes['POST /api/invites'],
  familyRoutes['DELETE /api/devices/:id'],
  licenceRoutes['POST /api/slot'],
]);

// The landing site (SITE_ORIGIN) opens Checkout in a modal and shows the public numbers: it may call
// these routes cross-origin.
const SITE_ROUTES = new Set(['/api/checkout', '/api/unlock/session', '/api/public/stats']);

function withCors(res, origin) {
  const out = new Response(res.body, res);
  out.headers.set('access-control-allow-origin', origin);
  out.headers.set('vary', 'origin');
  return out;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const origin = req.headers.get('origin');
    const site = env.SITE_ORIGIN && origin === env.SITE_ORIGIN && SITE_ROUTES.has(url.pathname) ? origin : null;
    if (req.method === 'OPTIONS' && site) {
      return new Response(null, {
        status: 204,
        headers: { 'access-control-allow-origin': site, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'origin' },
      });
    }
    const res = await handle(req, env, ctx);
    return site ? withCors(res, site) : res;
  },
};

async function handle(req, env, ctx) {
  try {
    const match = route(req, routes);
    if (!match || !deviceRoutes.has(match.handler)) {
      const ip = req.headers.get('cf-connecting-ip') || 'unknown';
      if (await limited(env.RL_API, ip)) throw new HttpError(429, 'rate-limited');
    }
    if (!match) throw new HttpError(404, 'not-found');
    return await match.handler(req, env, ctx, match.params);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, ...e.extra }, e.status);
    console.error(e);
    return json({ error: 'internal' }, 500);
  }
}
