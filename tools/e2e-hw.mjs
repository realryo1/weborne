// End-to-end test in headless Chrome against the real torne: the page gets a
// stand-in navigator.usb whose transfers are relayed over the DevTools
// protocol to the device, opened here with the `usb` package. Then the app is
// driven as a user would: connect, pick a channel, watch.
//   node tools/e2e-hw.mjs [channel] [seconds] [quality]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { WebUSB } = require('usb');
const ch = Number(process.argv[2] || 27);
const seconds = Number(process.argv[3] || 15);
const quality = process.argv[4] || 'light';

const webusb = new WebUSB({ allowAllDevices: true });
const device = (await webusb.getDevices()).find((d) => d.vendorId === 0x054c && d.productId === 0x04b2);
if (!device) throw new Error('CECH-ZD1 J not found');

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = mkdtempSync(join(process.cwd(), '.work/chrome-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const page = (await (await fetch('http://127.0.0.1:9334/json')).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const waits = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400);
  return r.result.result.value;
};
const reply = (callId, ok, payload) => send('Runtime.evaluate', { expression: `__usbReply(${callId}, ${ok}, ${JSON.stringify(payload)})` });

const counts = { cin: 0, cout: 0, in: 0, out: 0 };
async function usbOp({ id: callId, op, args }) {
  try {
    let result = null;
    if (op === 'open') { if (!device.opened) await device.open(); if (device.configuration === null) await device.selectConfiguration(1); await device.claimInterface(0); await device.selectAlternateInterface(0, 0); }
    else if (op === 'close') { await device.close(); }
    else if (op === 'cin') { counts.cin++; const r = await device.controlTransferIn(args.setup, args.length); result = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength).toString('base64'); }
    else if (op === 'cout') { counts.cout++; const r = await device.controlTransferOut(args.setup, Buffer.from(args.data, 'base64')); result = r.bytesWritten; }
    else if (op === 'in') { counts.in++; const r = await device.transferIn(args.ep, args.length); result = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength).toString('base64'); }
    else if (op === 'out') { counts.out++; const r = await device.transferOut(args.ep, Buffer.from(args.data, 'base64')); result = r.bytesWritten; }
    await reply(callId, true, result);
  } catch (error) {
    await reply(callId, false, String(error && error.message || error));
  }
}

ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  if (m.method === 'Runtime.bindingCalled' && m.params.name === '__usbCall') usbOp(JSON.parse(m.params.payload));
  if (m.method === 'Runtime.consoleAPICalled') console.log('console.' + m.params.type, m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
  if (m.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', JSON.stringify(m.params.exceptionDetails).slice(0, 600));
});

const fake = `(() => {
  const pending = new Map(); let seq = 0;
  window.__usbReply = (id, ok, payload) => { const p = pending.get(id); pending.delete(id); ok ? p.resolve(payload) : p.reject(new Error(payload)); };
  const call = (op, args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); window.__usbCall(JSON.stringify({ id, op, args })); });
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const fromB64 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const bytes = (d) => d instanceof Uint8Array ? d : new Uint8Array(d.buffer || d, d.byteOffset || 0, d.byteLength);
  const dev = {
    vendorId: 0x054c, productId: 0x04b2, opened: false, configuration: null,
    async open() { await call('open'); this.opened = true; this.configuration = { configurationValue: 1 }; },
    async selectConfiguration() {}, async claimInterface() {}, async selectAlternateInterface() {}, async clearHalt() {},
    async close() { await call('close'); this.opened = false; },
    async controlTransferIn(setup, length) { const r = await call('cin', { setup, length }); const u = fromB64(r); return { status: 'ok', data: new DataView(u.buffer) }; },
    async controlTransferOut(setup, data) { const r = await call('cout', { setup, data: b64(bytes(data)) }); return { status: 'ok', bytesWritten: r }; },
    async transferIn(ep, length) { const r = await call('in', { ep, length }); const u = fromB64(r); return { status: 'ok', data: new DataView(u.buffer) }; },
    async transferOut(ep, data) { const r = await call('out', { ep, data: b64(bytes(data)) }); return { status: 'ok', bytesWritten: r }; },
  };
  Object.defineProperty(navigator, 'usb', { value: { getDevices: async () => [dev], requestDevice: async () => dev, addEventListener() {} } });
  localStorage.setItem('weborne.channels', JSON.stringify([{ ch: ${ch}, freq: ${473142857 + (ch - 13) * 6000000}, name: '', services: [] }]));
  localStorage.setItem('weborne.quality', '${quality}');
})();`;

await send('Runtime.enable');
await send('Page.enable');
await send('Runtime.addBinding', { name: '__usbCall' });
await send('Page.addScriptToEvaluateOnNewDocument', { source: fake });
await send('Page.navigate', { url: 'http://localhost:8080/' });
const t0 = performance.now();
const t = () => ((performance.now() - t0) / 1000).toFixed(1);
// The app connects by itself once loaded, since getDevices() lists the board.
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const usbChip = await evaluate("document.getElementById('chip-usb').textContent");
  if (usbChip === 'USB 接続' || usbChip === 'USB エラー') break;
}
console.log(t(), 'chips', await evaluate("[...document.querySelectorAll('.chip')].map(c => c.textContent).join(' | ')"));
console.log(t(), 'message', await evaluate("document.getElementById('overlay-message').textContent"));
if (quality === 'scan') {
  await evaluate("document.getElementById('scan').click(), 'scan'");
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const text = await evaluate("document.getElementById('scan-text').textContent");
    if (i % 15 === 0) console.log(t(), text);
    if (await evaluate("document.getElementById('scan-progress').hidden")) break;
  }
  console.log(t(), 'scan done:', await evaluate("[...document.querySelectorAll('.channel')].map(b => b.textContent).join(' / ')"));
  console.log(t(), 'message', await evaluate("document.getElementById('overlay-message').textContent"));
  await evaluate('weborne.release().then(() => "released")');
  ws.close(); proc.kill(); await device.close().catch(() => {}); process.exit(0);
}
await evaluate("document.querySelector('.channel').click(), 'clicked'");
for (let i = 0; i < seconds; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (i % 3 === 2) console.log(t(), await evaluate(`JSON.stringify({ chips: [...document.querySelectorAll('.chip')].map(c => c.textContent), stats: document.getElementById('stats').textContent, msg: document.getElementById('overlay-message').textContent, title: document.getElementById('overlay-title').textContent, p: weborneDebug.player.stats, now: weborneDebug.player.mediaNow(), q: (weborneDebug.player.queue||[]).map(f => f.time).filter((_, i, a) => i === 0 || i === a.length - 1), anchor: weborneDebug.player.anchor, ct: weborneDebug.player.audio && weborneDebug.player.audio.currentTime, st: weborneDebug.player.audio && weborneDebug.player.audio.state })`));
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('.work/screens/e2e.png', Buffer.from(shot.result.data, 'base64'));
console.log(t(), 'player', await evaluate('JSON.stringify({ running: weborneDebug.player.running, info: weborneDebug.player.info(), stopRequested: weborneDebug.player.stopRequested, pushed: weborneDebug.player.pushed })'));
console.log(t(), 'go', await evaluate('weborne.status().then(s => JSON.stringify(s))'));
console.log(t(), 'usb ops', JSON.stringify(counts));
console.log('log:\n' + (await evaluate("document.getElementById('log').textContent")).split('\n').filter((l) => !/codec parameters|analyzeduration|Last message/.test(l)).slice(-15).join('\n'));
console.log(t(), 'channels', await evaluate("localStorage.getItem('weborne.channels')"));
await evaluate('weborne.release().then(() => "released")');
ws.close();
proc.kill();
await device.close().catch(() => {});
process.exit(0);
