import { HttpError, json, limited, route } from './http.js';
import { familyRoutes } from './family.js';
import { licenceRoutes } from './licence.js';
import { syncRoutes } from './sync.js';
import { photoRoutes } from './photos.js';

// Later tasks add routes here as 'METHOD /api/path/:param': async (req, env, ctx, params) => Response.
export const routes = { ...licenceRoutes, ...familyRoutes, ...syncRoutes, ...photoRoutes };

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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
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
  },
};
