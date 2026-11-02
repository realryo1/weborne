import { readFileSync } from 'node:fs';
import { MkvReader } from '../web/mkv.js';
const data = readFileSync(process.argv[2]);
const counts = {}; let first = {}, last = {};
const r = new MkvReader({
  onTracks: (t) => console.log('tracks', JSON.stringify(t)),
  onBlock: (t, ms, b) => { counts[t.number] = (counts[t.number]||0)+1; first[t.number] ??= [ms, b.length]; last[t.number] = [ms, b.length]; },
});
for (let i = 0; i < data.length; i += 7777) r.push(data.subarray(i, Math.min(i + 7777, data.length)));
console.log(counts, first, last);
