import { readFileSync } from 'node:fs';
import { createRing, Ring } from '../web/ring.js';
const data = readFileSync(process.argv[2]);
const options = JSON.parse(process.argv[3] || '{}');
const stats = { video: 0, audio: 0, firstV: null, firstA: null, lastV: null, logs: [] };
let t0 = performance.now();
import { fileURLToPath } from 'node:url';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, o) => String(url).startsWith('file:') ? new Response(readFileSync(fileURLToPath(String(url))), { headers: { 'content-type': 'application/wasm' } }) : realFetch(url, o);
globalThis.self = {
  location: { href: new URL('../web/decoder-worker.js', import.meta.url).href },
  postMessage(m) {
    if (m.type === 'video') { stats.video++; stats.firstV ??= [m.time, m.width, m.height, m.data.length]; stats.lastV = m.time; }
    else if (m.type === 'audio') { stats.audio++; stats.firstA ??= [m.time, m.pcm.length]; }
    else if (m.type === 'log') stats.logs.push(m.message.trim());
    else console.log('msg', JSON.stringify(m));
  },
};
await import('../web/decoder-worker.js');
const sab = createRing(data.length + 1024);
const ring = new Ring(sab);
await self.onmessage({ data: { type: 'init', sab } });
ring.push(new Uint8Array(data)); ring.close();
t0 = performance.now();
await self.onmessage({ data: { type: 'run', options } });
const el = (performance.now() - t0) / 1000;
console.log(JSON.stringify({ ...stats, logs: stats.logs.slice(0, 8) }), 'elapsed', el.toFixed(2), 's', 'fps', (stats.video / el).toFixed(1));
