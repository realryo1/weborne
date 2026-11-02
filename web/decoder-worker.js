// Decoder worker: runs ffmpeg.wasm over the descrambled transport stream.
//
// ffmpeg reads /dev/tsin, a device whose read() blocks on the shared ring the
// page fills, and writes Matroska carrying raw yuv420p video and float PCM to
// /dev/avout, which is parsed here and posted to the page frame by frame with
// its timestamp. ffmpeg.exec() blocks this worker for as long as the stream
// runs; the page ends it by closing the ring.

import createFFmpegCore from './ffmpeg/ffmpeg-core.js';
import { Ring } from './ring.js';
import { MkvReader } from './mkv.js';

let core = null;
let coreReady = null;
let aborted = false;
let ring = null;
let reader = null;
let video = null;
let audio = null;
let audioPending = null;

// Audio is posted in pieces of about 100 ms so the page schedules fewer nodes.
const AUDIO_BATCH_SAMPLES = 4800;

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

function flushAudio() {
  if (!audioPending || audioPending.length === 0) return;
  const total = audioPending.parts.reduce((n, p) => n + p.length, 0);
  const pcm = new Float32Array(total);
  let offset = 0;
  for (const p of audioPending.parts) { pcm.set(p, offset); offset += p.length; }
  post({ type: 'audio', time: audioPending.time, rate: audio.rate, channels: audio.channels, pcm }, [pcm.buffer]);
  audioPending = null;
}

function onBlock(track, ms, bytes) {
  if (!track) return;
  if (track.type === 1) {
    const frame = bytes.slice();
    post({ type: 'video', time: ms, width: track.width, height: track.height, data: frame }, [frame.buffer]);
  } else if (track.type === 2) {
    // Copy out of the parser's buffer, keeping float alignment.
    const samples = new Float32Array(bytes.byteLength / 4);
    new Uint8Array(samples.buffer).set(bytes);
    if (!audioPending) audioPending = { time: ms, parts: [], length: 0 };
    audioPending.parts.push(samples);
    audioPending.length += samples.length / audio.channels;
    if (audioPending.length >= AUDIO_BATCH_SAMPLES) flushAudio();
  }
}

function onTracks(tracks) {
  video = tracks.find((t) => t.type === 1) || null;
  audio = tracks.find((t) => t.type === 2) || null;
  post({ type: 'tracks', video, audio });
}

// Registers a character device with buffer-wide read/write, which ffmpeg's
// file protocol opens like any file. (FS.createDevice moves one byte per call,
// far too slow for raw video.)
function makeDevice(FS, path, ops, major) {
  const dev = FS.makedev(major, 0);
  FS.registerDevice(dev, {
    open(stream) { stream.seekable = false; },
    close() {},
    read(stream, buffer, offset, length) {
      if (!ops.read) throw new FS.ErrnoError(28);
      return ops.read(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length));
    },
    write(stream, buffer, offset, length) {
      if (!ops.write) throw new FS.ErrnoError(28);
      ops.write(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length));
      return length;
    },
    llseek() { throw new FS.ErrnoError(29); },
  });
  FS.mkdev(path, 0o666, dev);
}

// After an abort (ffmpeg calls abort() on some fatal errors) the runtime is
// dead and has to be made again.
async function createCore() {
  aborted = false;
  core = await createFFmpegCore({
    locateFile: (path) => new URL(`./ffmpeg/${path}`, import.meta.url).href,
  });
  core.setLogger(({ type, message }) => {
    if (message.includes('Aborted(')) aborted = true;
    if (type === 'stderr' && message.trim()) post({ type: 'log', message });
  });
  const FS = core.FS;
  makeDevice(FS, '/dev/tsin', { read: (target) => ring.read(target) }, 240);
  makeDevice(FS, '/dev/avout', { write: (bytes) => reader && reader.push(bytes) }, 241);
}

async function init(sab) {
  ring = new Ring(sab);
  coreReady = createCore();
  await coreReady;
  post({ type: 'ready' });
}

// ffmpeg arguments for a preset:
//   full   1440x1080 (or whatever the broadcast is), every frame
//   light  MPEG-2 decoded at half resolution (lowres), a quarter of the work
//   one    one-seg H.264, tiny
function args(options) {
  const input = [
    '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y',
    '-threads', '1',
    '-fflags', '+nobuffer+discardcorrupt',
    // No '-flags low_delay': it makes the MPEG-2 decoder skip reordering, so
    // every P frame shows before the B frames ahead of it and motion shakes.
    // One-seg runs at ~300 kb/s: a probe sized for HD would take a minute.
    '-probesize', options.small ? '150000' : '1500000',
    '-analyzeduration', '1500000',
  ];
  if (options.lowres) input.push('-lowres', '1');
  // Bilingual programmes carry both languages in one AAC stream (dual mono);
  // left alone the decoder plays the main language left and the second right.
  input.push('-dual_mono_mode', options.dualMono || 'main');
  input.push('-f', 'mpegts', '-i', '/dev/tsin');
  const out = ['-map', '0:v:0', '-map', `0:a:${options.audio || 0}?`];
  const filters = [];
  if (options.width && options.height) filters.push(`scale=${options.width}:${options.height}:flags=fast_bilinear`);
  if (filters.length) out.push('-vf', filters.join(','));
  out.push(
    '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_f32le', '-ac', '2', '-ar', '48000',
    '-f', 'matroska', '-live', '1', '-cluster_time_limit', '40', '-cluster_size_limit', '262144',
    '-flush_packets', '1',
    '/dev/avout',
  );
  return [...input, ...out];
}

function run(options) {
  reader = new MkvReader({ onTracks, onBlock });
  video = audio = null;
  audioPending = null;
  post({ type: 'started' });
  let code = -1;
  try {
    core.reset();
    core.exec(...args(options));
    code = core.ret;
  } catch (error) {
    aborted = true;
    post({ type: 'log', message: `ffmpeg: ${error && error.message ? error.message : error}` });
  }
  flushAudio();
  reader = null;
  if (aborted) coreReady = createCore();
  post({ type: 'ended', code });
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === 'init') await init(message.sab);
    else if (message.type === 'run') {
      await coreReady;
      run(message.options || {});
    }
  } catch (error) {
    post({ type: 'error', message: String(error && error.message ? error.message : error) });
  }
};
