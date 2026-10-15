// Andata e Ritorno (A/R) API (skeleton). Auth is delegated to Cloudflare Access:
// the authenticated email arrives in the Cf-Access-Authenticated-User-Email header.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const user = req.headers.get('cf-access-authenticated-user-email') || 'dev';
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','items',id]

    if (parts[0] !== 'api') return env.ASSETS.fetch(req);

    // GET /api/items?child=nido
    if (req.method === 'GET' && parts[1] === 'items' && !parts[2]) {
      const child = url.searchParams.get('child');
      const { results } = await env.DB
        .prepare('SELECT * FROM items WHERE (?1 IS NULL OR child = ?1) ORDER BY moved_at DESC')
        .bind(child).all();
      return json(results);
    }

    // POST /api/items  (multipart: photo, child, label)
    if (req.method === 'POST' && parts[1] === 'items') {
      const form = await req.formData();
      const photo = form.get('photo');
      const child = form.get('child');
      if (!photo || !['nido', 'materna'].includes(child)) return json({ error: 'invalid input' }, 400);
      const id = crypto.randomUUID();
      const key = `${id}.webp`;
      const now = new Date().toISOString();
      await env.PHOTOS.put(key, photo.stream(), { httpMetadata: { contentType: photo.type || 'image/webp' } });
      await env.DB.prepare('INSERT INTO items (id, child, location, label, photo_key, moved_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, child, 'home', form.get('label') || '', key, now).run();
      return json({ id }, 201);
    }

    // POST /api/move  { ids: [...], location: 'school' | 'home' }
    if (req.method === 'POST' && parts[1] === 'move') {
      const { ids, location } = await req.json();
      if (!Array.isArray(ids) || !['school', 'home'].includes(location)) return json({ error: 'invalid input' }, 400);
      const now = new Date().toISOString();
      await env.DB.batch(ids.flatMap(id => [
        env.DB.prepare('UPDATE items SET location = ?, moved_at = ? WHERE id = ?').bind(location, now, id),
        env.DB.prepare('INSERT INTO moves (item_id, location, moved_at, moved_by) VALUES (?, ?, ?, ?)').bind(id, location, now, user),
      ]));
      return json({ ok: true });
    }

    // DELETE /api/items/:id
    if (req.method === 'DELETE' && parts[1] === 'items' && parts[2]) {
      const row = await env.DB.prepare('SELECT photo_key FROM items WHERE id = ?').bind(parts[2]).first();
      if (!row) return json({ error: 'not found' }, 404);
      await env.PHOTOS.delete(row.photo_key);
      await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(parts[2]).run();
      return json({ ok: true });
    }

    // GET /api/photo/:key
    if (req.method === 'GET' && parts[1] === 'photo' && parts[2]) {
      const obj = await env.PHOTOS.get(parts[2]);
      if (!obj) return new Response('not found', { status: 404 });
      return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/webp', 'cache-control': 'private, max-age=31536000, immutable' } });
    }

    return json({ error: 'not found' }, 404);
  },
};
