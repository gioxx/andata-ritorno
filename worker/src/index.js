import { HttpError, clientIp, json, limited, route } from './http.js';
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

/** Local development: the app's dev server proxies to a local Worker on another port. */
const isLocal = (origin, url) => /^(localhost|127\.0\.0\.1)$/.test(url.hostname) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

/** Headers on every API answer: no MIME sniffing, no embedding, readable only by same-site pages. */
function secure(res) {
  const out = new Response(res.body, res);
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('cross-origin-resource-policy', 'same-site');
  out.headers.set('x-frame-options', 'DENY');
  if (!out.headers.has('content-security-policy')) out.headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  return out;
}

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
    // Browsers name the page that made a request: only the app itself (and the landing site, on
    // its routes) may use the API from a web page. Requests without an Origin (the app's own
    // navigations, Stripe's webhook, scripts) go on to the usual checks.
    if (origin && !site && origin !== url.origin && origin !== env.APP_ORIGIN && !isLocal(origin, url)) {
      return secure(json({ error: 'forbidden-origin' }, 403));
    }
    if (req.method === 'OPTIONS' && site) {
      return new Response(null, {
        status: 204,
        headers: { 'access-control-allow-origin': site, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'origin' },
      });
    }
    const res = secure(await handle(req, env, ctx));
    return site ? withCors(res, site) : res;
  },
};

async function handle(req, env, ctx) {
  try {
    const match = route(req, routes);
    if (!match || !deviceRoutes.has(match.handler)) {
      if (await limited(env.RL_API, clientIp(req))) throw new HttpError(429, 'rate-limited');
    }
    if (!match) throw new HttpError(404, 'not-found');
    return await match.handler(req, env, ctx, match.params);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, ...e.extra }, e.status);
    console.error(e);
    return json({ error: 'internal' }, 500);
  }
}
