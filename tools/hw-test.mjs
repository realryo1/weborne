// Hardware test without a browser: runs web/weborne.wasm and web/usb.js in
// Node against the real CECH-ZD1 J through the `usb` package's WebUSB API.
//   node tools/hw-test.mjs [channel] [seconds] [out.ts]
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { TorneUSB } from '../web/usb.js';

const require = createRequire(import.meta.url);
const { WebUSB } = require('usb');
require('../web/wasm_exec.js');

const ch = Number(process.argv[2] || 27);
const seconds = Number(process.argv[3] || 8);
const outPath = process.argv[4] || '.work/samples/hw.ts';
const t = () => (performance.now() / 1000).toFixed(2);

const webusb = new WebUSB({ allowAllDevices: true });
const device = (await webusb.getDevices()).find((d) => d.vendorId === 0x054c && d.productId === 0x04b2);
if (!device) throw new Error('CECH-ZD1 J not found');

const ready = new Promise((resolve) => { globalThis.onWeborneReady = resolve; });
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(readFileSync(new URL('../web/weborne.wasm', import.meta.url)), go.importObject);
go.run(instance);
await ready;
const wt = globalThis.weborne;

const usb = new TorneUSB(device);
await usb.open();
console.log(t(), 'opened');
const attached = await wt.attach(usb);
console.log(t(), 'attached', JSON.stringify(attached));
const freq = 473142857 + (ch - 13) * 6000000;
const status = await wt.tune(freq);
console.log(t(), 'tuned', JSON.stringify(status));
const chunks = [];
let services = null;
usb.flushStream();
await wt.start((u8) => chunks.push(Uint8Array.from(u8)), (json) => { services = JSON.parse(json); });
for (let i = 0; i < seconds; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const s = await wt.status();
  console.log(t(), 'status', JSON.stringify(s));
}
await wt.stop();
console.log(t(), 'services', JSON.stringify((services || []).map((s) => [s.id, s.name, s.codec])));
const total = chunks.reduce((n, c) => n + c.length, 0);
const out = new Uint8Array(total);
let o = 0;
for (const c of chunks) { out.set(c, o); o += c.length; }
writeFileSync(outPath, out);
console.log(t(), 'wrote', total, 'bytes to', outPath);
await wt.release();
await usb.close();
process.exit(0);
