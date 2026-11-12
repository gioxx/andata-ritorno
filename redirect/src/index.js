// Old hostnames on gioxx.org and their new home on gxware.org. Path, query and fragment are kept
// (the browser keeps the fragment across a redirect by itself).
const TARGETS = {
  'ar.gioxx.org': 'ar.gxware.org',
  'app.ar.gioxx.org': 'app.ar.gxware.org',
};

export default {
  fetch(req) {
    const url = new URL(req.url);
    const host = TARGETS[url.hostname];
    if (!host) return new Response('Not found', { status: 404 });
    url.hostname = host;
    url.protocol = 'https:';
    return new Response(null, {
      status: 301,
      headers: { location: url.toString(), 'cache-control': 'public, max-age=86400' },
    });
  },
};
