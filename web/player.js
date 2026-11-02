// Player: feeds the decoder worker and presents what comes back.
//
// Audio is the clock. The first audio block anchors media time to the
// AudioContext's clock a little in the future; every audio block is scheduled
// at its own time on that line, and each animation frame shows the newest
// video frame whose time has come. Without audio, the first video frame
// anchors the line to performance.now() instead.

import { createRing, Ring } from './ring.js';

const RING_BYTES = 12 * 1024 * 1024; // about 6 s of a full multiplex service
const START_LATENCY = 0.35; // seconds of audio scheduled ahead
// Video arrives up to a second ahead of the audio for the same moment (a
// transport stream sends video early), so frames wait here until the audio
// clock reaches them. Bounded by bytes: 1440x1080 is 2.3 MB a frame.
const MAX_VIDEO_BYTES = 192 * 1024 * 1024;

const VERTEX = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = vec2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D ty;
uniform sampler2D tu;
uniform sampler2D tv;
uniform float deinterlace;
uniform float lineStep;
varying vec2 uv;
void main() {
  float y = texture2D(ty, uv).r;
  if (deinterlace > 0.5) {
    // Blend the two fields: cheap, and no combing on motion.
    y = 0.5 * (y + texture2D(ty, uv + vec2(0.0, lineStep)).r);
  }
  float u = texture2D(tu, uv).r - 0.5;
  float v = texture2D(tv, uv).r - 0.5;
  y = (y - 0.0627) * 1.1644;
  u *= 1.1384;
  v *= 1.1384;
  gl_FragColor = vec4(y + 1.5748 * v, y - 0.1873 * u - 0.4681 * v, y + 1.8556 * u, 1.0);
}`;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL が使えません');
    this.gl = gl;
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.textures = ['ty', 'tu', 'tv'].map((name, i) => {
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, name), i);
      return texture;
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.uDeinterlace = gl.getUniformLocation(program, 'deinterlace');
    this.uLineStep = gl.getUniformLocation(program, 'lineStep');
    this.size = [0, 0];
    this.deinterlace = true;
  }

  draw(frame) {
    const gl = this.gl;
    const { width: w, height: h, data } = frame;
    const cw = w >> 1;
    const ch = h >> 1;
    const fresh = this.size[0] !== w || this.size[1] !== h;
    const planes = [
      [data.subarray(0, w * h), w, h],
      [data.subarray(w * h, w * h + cw * ch), cw, ch],
      [data.subarray(w * h + cw * ch, w * h + 2 * cw * ch), cw, ch],
    ];
    planes.forEach(([plane, pw, ph], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
      if (fresh) gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, pw, ph, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, plane);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pw, ph, gl.LUMINANCE, gl.UNSIGNED_BYTE, plane);
    });
    this.size = [w, h];
    const dpr = window.devicePixelRatio || 1;
    const cw2 = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const ch2 = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw2 || this.canvas.height !== ch2) {
      this.canvas.width = cw2;
      this.canvas.height = ch2;
    }
    gl.viewport(0, 0, cw2, ch2);
    gl.uniform1f(this.uDeinterlace, this.deinterlace && h >= 480 ? 1 : 0);
    gl.uniform1f(this.uLineStep, 1 / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  clear() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

export class Player {
  constructor(canvas, { onLog, onState } = {}) {
    this.renderer = new Renderer(canvas);
    this.renderer.clear();
    this.onLog = onLog || (() => {});
    this.onState = onState || (() => {});
    this.sab = createRing(RING_BYTES);
    this.ring = new Ring(this.sab);
    this.worker = new Worker(new URL('./decoder-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.message(e.data);
    this.worker.onerror = (e) => this.onLog(`デコーダのエラー: ${e.message}`);
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.worker.postMessage({ type: 'init', sab: this.sab });
    this.running = false;
    this.ended = Promise.resolve();
    this.audio = null;
    this.gain = null;
    this.volume = 1;
    this.muted = false;
    this.stats = { frames: 0, shown: 0, late: 0, audioBlocks: 0 };
    this.lastStats = { at: performance.now(), shown: 0 };
    this.fps = 0;
    this.raf = requestAnimationFrame(() => this.tick());
  }

  // Must run from a user gesture the first time, so audio may start.
  unlockAudio() {
    if (!this.audio) {
      const Context = window.AudioContext || window.webkitAudioContext;
      this.audio = new Context({ latencyHint: 'playback', sampleRate: 48000 });
      this.gain = this.audio.createGain();
      this.gain.connect(this.audio.destination);
      this.applyVolume();
    }
    if (this.audio.state === 'suspended') this.audio.resume();
  }

  setVolume(volume) { this.volume = volume; this.applyVolume(); }
  setMuted(muted) { this.muted = muted; this.applyVolume(); }
  applyVolume() { if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume; }
  set deinterlace(on) { this.renderer.deinterlace = on; }

  message(m) {
    switch (m.type) {
      case 'ready': this.resolveReady(); break;
      case 'started': this.onLog('デコーダ開始'); break;
      case 'error': this.rejectReady(new Error(m.message)); this.onLog(m.message); break;
      case 'log': this.onLog(m.message.trim()); break;
      case 'tracks':
        this.lastTracks = m.audio ? 'av' : 'video-only';
        this.onState({ tracks: m });
        break;
      case 'video': this.video(m); break;
      case 'audio': this.audioBlock(m); break;
      case 'ended':
        this.running = false;
        if (this.resolveEnded) this.resolveEnded(m.code);
        this.onState({ ended: m.code, requested: this.stopRequested });
        break;
      default: break;
    }
  }

  async start(options) {
    await this.ready;
    await this.stop();
    this.ring.reset();
    this.queue = [];
    this.queueBytes = 0;
    this.anchor = null;
    this.smooth = null;
    this.lastTracks = null;
    this.nextAudio = 0;
    this.stats = { frames: 0, shown: 0, late: 0, audioBlocks: 0 };
    this.running = true;
    this.stopRequested = false;
    this.ended = new Promise((resolve) => { this.resolveEnded = resolve; });
    this.worker.postMessage({ type: 'run', options });
  }

  async stop() {
    if (!this.running) return;
    this.stopRequested = true;
    this.ring.close();
    await this.ended;
    this.queue = [];
    this.queueBytes = 0;
    this.anchor = null;
  }

  push(bytes) {
    this.pushed = (this.pushed || 0) + bytes.length;
    if (this.running) this.ring.push(bytes);
  }

  // Where audio output is now, in AudioContext seconds. currentTime moves in
  // steps of a render quantum or a whole device buffer (tens of ms on some
  // devices); the output timestamp, carried forward on performance.now(),
  // is finer.
  audioTime() {
    const ctx = this.audio;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.performanceTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return ctx.currentTime;
  }

  // Media time (ms) now, on the anchored line. Video is timed on a smooth
  // clock that runs on performance.now() and is only nudged toward the audio
  // clock, so that a coarse audio clock does not show some frames for one
  // refresh and others for three (judder on every pan).
  mediaNow() {
    if (!this.anchor) return null;
    const wall = performance.now();
    if (this.anchor.clock !== 'audio') return this.anchor.media + (wall / 1000 - this.anchor.at) * 1000;
    const target = this.anchor.media + (this.audioTime() - this.anchor.at) * 1000;
    if (!this.smooth || Math.abs(this.smooth.base + wall - target) > 80) {
      this.smooth = { base: target - wall };
    } else {
      this.smooth.base += (target - (this.smooth.base + wall)) * 0.02;
    }
    return this.smooth.base + wall;
  }

  audioBlock(m) {
    this.stats.audioBlocks++;
    if (!this.audio || !this.running) return;
    const ctx = this.audio;
    if (!this.anchor || this.anchor.clock !== 'audio') {
      this.anchor = { clock: 'audio', media: m.time, at: ctx.currentTime + START_LATENCY };
    }
    let when = this.anchor.at + (m.time - this.anchor.media) / 1000;
    const frames = m.pcm.length / m.channels;
    // Drifted too far behind (the decoder stalled): restart the line here.
    if (when < ctx.currentTime) {
      this.anchor = { clock: 'audio', media: m.time, at: ctx.currentTime + START_LATENCY };
      when = this.anchor.at;
    }
    // Small overlaps from rounding are cut by starting where the last ended.
    if (Math.abs(when - this.nextAudio) < 0.02) when = Math.max(when, this.nextAudio);
    const buffer = ctx.createBuffer(m.channels, frames, m.rate);
    for (let c = 0; c < m.channels; c++) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < frames; i++) channel[i] = m.pcm[i * m.channels + c];
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start(when);
    this.nextAudio = when + frames / m.rate;
  }

  video(m) {
    this.stats.frames++;
    if (!this.running) return;
    if (!this.anchor && !this.audioExpected()) {
      this.anchor = { clock: 'wall', media: m.time, at: performance.now() / 1000 + 0.1 };
    }
    this.queue.push(m);
    this.queueBytes += m.data.byteLength;
    while (this.queueBytes > MAX_VIDEO_BYTES && this.queue.length > 1) {
      this.queueBytes -= this.queue.shift().data.byteLength;
      this.stats.late++;
    }
  }

  audioExpected() {
    return !!this.audio && this.lastTracks !== 'video-only';
  }

  tick() {
    this.raf = requestAnimationFrame(() => this.tick());
    const now = this.mediaNow();
    if (this.queue && this.queue.length) {
      if (now === null) {
        // Waiting for the first audio. Show the first frame meanwhile, but
        // do not hold video for ever if the stream has no audio.
        if (this.queue.length > 8 && !this.anchor) {
          this.anchor = { clock: 'wall', media: this.queue[0].time, at: performance.now() / 1000 };
        }
      } else {
        let frame = null;
        while (this.queue.length && this.queue[0].time <= now + 8) {
          if (frame) this.stats.late++;
          frame = this.queue.shift();
          this.queueBytes -= frame.data.byteLength;
        }
        if (frame) {
          this.renderer.draw(frame);
          this.stats.shown++;
        }
      }
    }
    const t = performance.now();
    if (t - this.lastStats.at >= 1000) {
      this.fps = ((this.stats.shown - this.lastStats.shown) * 1000) / (t - this.lastStats.at);
      this.lastStats = { at: t, shown: this.stats.shown };
    }
  }

  info() {
    return {
      fps: this.fps,
      late: this.stats.late,
      buffered: this.ring.used(),
      dropped: Atomics.load(this.ring.header, 3),
      queue: this.queue ? this.queue.length : 0,
    };
  }

  clear() { this.renderer.clear(); }
}
