// Service worker: makes weborne an installable app that opens offline, and
// adds the headers that make the page cross-origin isolated (COOP/COEP, for
// SharedArrayBuffer) on hosts that cannot send them, such as GitHub Pages.
//
// Every file the app needs is cached at install. Watching needs no network
// (the tuner is on USB), so once installed the app works with none.
// VERSION is replaced with the commit by the deploy workflow; a new version
// caches afresh and drops the old cache. Under 'dev' (local serving) the
// network is tried first so edits show up on reload.

const VERSION = 'dev';
const CACHE = `weborne-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'usb.js',
  'player.js',
  'ring.js',
  'mkv.js',
  'decoder-worker.js',
  'wasm_exec.js',
  'weborne.wasm',
  'ffmpeg/ffmpeg-core.js',
  'ffmpeg/ffmpeg-core.wasm',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'driver/weborne-winusb.bat',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 'reload' skips the HTTP cache, so a new version never caches old files.
    await cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('weborne-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

function isolate(response) {
  if (!response || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function fromCache(request) {
  const cache = await caches.open(CACHE);
  // A page opened as ./?x or ./index.html is the same page.
  return (await cache.match(request, { ignoreSearch: true }))
    || (request.mode === 'navigate' ? cache.match('./') : undefined);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // The manifest is what the browser identifies the installed app by, so it
  // always comes from the network when there is one.
  const fresh = VERSION === 'dev' || new URL(request.url).pathname.endsWith('.webmanifest');
  event.respondWith((async () => {
    if (!fresh) {
      const cached = await fromCache(request);
      if (cached) return isolate(cached);
    }
    try {
      return isolate(await fetch(request));
    } catch (error) {
      const cached = await fromCache(request);
      if (cached) return isolate(cached);
      throw error;
    }
  })());
});
