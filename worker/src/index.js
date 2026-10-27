import { HttpError, json, route } from './http.js';

// Later tasks add routes here as 'METHOD /api/path/:param': async (req, env, ctx, params) => Response.
export const routes = {};

/** Rate limiting is optional: without the binding there is simply no limiting. */
export async function limited(binding, key) {
  if (!binding) return false;
  const { success } = await binding.limit({ key });
  return !success;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const ip = req.headers.get('cf-connecting-ip') || 'unknown';
      if (await limited(env.RL_API, ip)) throw new HttpError(429, 'rate-limited');
      const match = route(req, routes);
      if (!match) throw new HttpError(404, 'not-found');
      return await match.handler(req, env, ctx, match.params);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, ...e.extra }, e.status);
      console.error(e);
      return json({ error: 'internal' }, 500);
    }
  },
};
