// weborne: watch a torne (CECH-ZD1 J) plugged into the phone over WebUSB.
//
//   usb.js             WebUSB transport the Go side drives
//   weborne.wasm      coax's MB86H47A/DiB8096 drivers + B-CAS + service filter (Go)
//   player.js          ffmpeg.wasm decoder worker, WebGL video, Web Audio

import { TorneUSB } from './usb.js';
import { Player } from './player.js';

const $ = (id) => document.getElementById(id);

// ---- cross-origin isolation (SharedArrayBuffer for the decoder) -----------

async function ensureIsolated() {
  if (window.crossOriginIsolated) return true;
  if (!('serviceWorker' in navigator)) return false;
  // Static hosts cannot send COOP/COEP; coi-sw.js adds them, after one reload.
  await navigator.serviceWorker.register('coi-sw.js');
  await navigator.serviceWorker.ready;
  if (!sessionStorage.getItem('weborne.coi-reloaded')) {
    sessionStorage.setItem('weborne.coi-reloaded', '1');
    location.reload();
    return new Promise(() => {});
  }
  return false;
}

// ---- channels -------------------------------------------------------------

const UHF_FIRST = 13;
const UHF_LAST = 62;
const frequencyOf = (ch) => 473142857 + (ch - UHF_FIRST) * 6000000;
const STORE = 'weborne.channels';

function loadChannels() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (Array.isArray(stored)) return stored;
  } catch { /* ignore */ }
  return [];
}

function saveChannels() {
  try { localStorage.setItem(STORE, JSON.stringify(channels)); } catch { /* ignore */ }
}

let channels = loadChannels();

function channelLabel(entry) {
  const main = entry.services && entry.services.find((s) => s.codec === 'mpeg2' && s.name);
  return (main && main.name) || entry.name || `${entry.ch}ch`;
}

function renderChannels() {
  const box = $('channels');
  box.textContent = '';
  if (channels.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'チャンネルがありません。接続してから「チャンネルスキャン」を押してください。';
    box.append(empty);
    return;
  }
  for (const entry of channels) {
    const button = document.createElement('button');
    button.className = 'channel';
    if (current && current.ch === entry.ch) button.classList.add('active');
    const number = document.createElement('span');
    number.className = 'ch';
    number.textContent = `${entry.ch}`;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = channelLabel(entry);
    button.append(number, name);
    button.addEventListener('click', () => play(entry));
    box.append(button);
  }
}

// ---- state ----------------------------------------------------------------

let player = null;
let usb = null;
let attached = false;
let current = null; // channel entry being watched
let services = [];
let chosenService = 0; // 0 = automatic
let busy = false;
let scanning = false;
let wakeLock = null;
let lastBytes = 0;
let lastStatusAt = 0;
let restarts = 0;

function log(message) {
  const pre = $('log');
  const line = `[${new Date().toLocaleTimeString()}] ${message}\n`;
  pre.textContent = (pre.textContent + line).slice(-20000);
}

function setMessage(text) {
  $('overlay-message').textContent = text || '';
  $('overlay').classList.toggle('hidden', !text && !!current);
}

function setChip(id, text, state) {
  const chip = $(id);
  chip.textContent = text;
  chip.dataset.state = state || '';
}

function quality() { return $('quality').value; }

function decoderOptions() {
  let options;
  switch (quality()) {
    case 'full': options = { width: 1440, height: 1080 }; break;
    case 'one': options = { width: 320, height: 180, small: true }; break;
    default: options = { lowres: 1, width: 720, height: 540 };
  }
  return { ...options, ...audioChoice() };
}

// 主音声／副音声. A second language comes either inside the one audio stream
// (dual mono, picked by the decoder) or as a second audio stream.
function audioMode() { return $('audio-mode').value; }

function audioChoice() {
  const mode = audioMode();
  const service = services.find((s) => s.id === activeService)
    || services.find((s) => s.codec === 'mpeg2' && s.audio && s.audio.length);
  const streams = service && service.audio ? service.audio.length : 1;
  if (mode === 'sub' && streams > 1) return { audio: 1, dualMono: 'main' };
  return { audio: 0, dualMono: mode };
}

let playingAudio = null;

// Which service to pass on: what the user picked, else for one-seg the
// H.264 service, else automatic (the first MPEG-2 TV service).
function wantedService() {
  if (chosenService) return chosenService;
  if (quality() === 'one') {
    const one = services.find((s) => s.codec === 'h264');
    if (one) return one.id;
  }
  return 0;
}

// ---- Go module ------------------------------------------------------------

function loadGo() {
  return new Promise((resolve, reject) => {
    window.onWeborneReady = () => resolve(window.weborne);
    const go = new window.Go();
    WebAssembly.instantiateStreaming(fetch('weborne.wasm'), go.importObject)
      .then(({ instance }) => go.run(instance))
      .catch(reject);
  });
}

let wt = null;

// ---- connect --------------------------------------------------------------

async function connect() {
  player.unlockAudio();
  if (attached) return;
  $('connect').disabled = true;
  try {
    let device = await TorneUSB.known();
    if (!device) device = await TorneUSB.request();
    setMessage('torneを初期化しています…');
    usb = new TorneUSB(device);
    await usb.open();
    setChip('chip-usb', 'USB接続中', 'busy');
    const result = await wt.attach(usb);
    attached = true;
    $('driver-help').hidden = true;
    setChip('chip-usb', 'USB接続', 'ok');
    if (result.card) setChip('chip-card', 'カードOK', 'ok');
    else setChip('chip-card', 'カードなし', 'bad');
    if (result.cardError) log(`カード: ${result.cardError}`);
    else log(`カードID ${result.cardId}`);
    $('connect').textContent = '接続済み';
    setMessage(channels.length ? 'チャンネルを選んでください' : '「チャンネルスキャン」で受信できるチャンネルを探してください');
    // A paused scan goes on by itself, unless something is being watched.
    if (loadScan() && !current) setTimeout(() => { if (!current && !busy) scan(); }, 0);
  } catch (error) {
    log(`接続に失敗: ${error.message || error}`);
    if (needsDriver(error)) {
      $('driver-help').hidden = false;
      $('driver-help').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setMessage('torneを開けませんでした。下の案内に従ってドライバを入れてください');
    } else {
      setMessage(`接続に失敗しました: ${error.message || error}`);
    }
    setChip('chip-usb', 'USBエラー', 'bad');
    if (usb) await usb.close();
    usb = null;
    $('connect').disabled = false;
  }
}

const isWindows = /Windows/.test(navigator.userAgent);

// On Windows a device without WinUSB is listed but cannot be opened or
// claimed ("Access denied"); the same happens while TVTest/coaxd holds it, so
// the guide mentions both. A chooser that found nothing is the other sign.
function needsDriver(error) {
  if (!isWindows) return false;
  const name = error && error.name;
  const text = String(error && error.message || error);
  if (name === 'NotFoundError' && /No device selected/i.test(text)) return true;
  return name === 'SecurityError' || name === 'NetworkError' || /access denied|unable to claim|failed to open|claim interface/i.test(text);
}

function disconnected() {
  attached = false;
  current = null;
  if (player) player.stop().then(() => player.clear());
  if (usb) usb.close();
  usb = null;
  setChip('chip-usb', 'USB未接続', '');
  setChip('chip-card', 'カード —', '');
  setChip('chip-signal', '信号 —', '');
  $('connect').disabled = false;
  $('connect').textContent = '接続';
  setMessage('torneが外されました。挿し直して「接続」を押してください');
  releaseWakeLock();
  renderChannels();
}

// ---- playback -------------------------------------------------------------

function onData(chunk) {
  player.push(chunk);
}

function onServices(json) {
  services = JSON.parse(json);
  if (current) {
    current.services = services.map(({ id, name, codec }) => ({ id, name, codec }));
    saveChannels();
    renderChannels();
    $('overlay-title').textContent = channelLabel(current);
  }
  renderServices();
  // A second audio stream is known only now.
  const audio = JSON.stringify(audioChoice());
  if (playingAudio !== null && audio !== playingAudio && player.running) {
    playingAudio = audio;
    restartPlayer();
  }
  // One-seg needs its own service, known only now.
  const wanted = wantedService();
  if (wanted && wanted !== activeService) {
    activeService = wanted;
    wt.select(wanted);
    restartPlayer();
  }
}

let activeService = 0;

function renderServices() {
  const select = $('service');
  select.textContent = '';
  const auto = document.createElement('option');
  auto.value = '0';
  auto.textContent = '自動（メイン）';
  select.append(auto);
  for (const s of services) {
    if (!s.video || s.video.length === 0) continue;
    const option = document.createElement('option');
    option.value = String(s.id);
    option.textContent = `${s.name || s.id}${s.codec === 'h264' ? '（ワンセグ）' : ''}`;
    select.append(option);
  }
  select.value = String(chosenService);
  select.disabled = services.length === 0;
}

async function restartPlayer() {
  await player.stop();
  const options = decoderOptions();
  playingAudio = JSON.stringify({ audio: options.audio, dualMono: options.dualMono });
  await player.start(options);
}

async function play(entry) {
  if (!attached) { await connect(); if (!attached) return; }
  if (busy) return;
  await pauseScan();
  busy = true;
  player.unlockAudio();
  try {
    current = entry;
    services = entry.services ? entry.services.map((s) => ({ ...s, video: [1] })) : [];
    renderServices();
    renderChannels();
    $('overlay-title').textContent = channelLabel(entry);
    setMessage(`${entry.ch}chを選局中…`);
    await player.stop();
    await wt.stop();
    const status = await wt.tune(entry.freq);
    showSignal(status);
    if (!status.locked) {
      setMessage(`${entry.ch}chは受信できません（信号なし）`);
      return;
    }
    // Choose from what is remembered of this channel, so one-seg starts on
    // its own service rather than being switched to once the PMTs arrive.
    services = (entry.services || []).map((s) => ({ ...s, video: s.codec ? [1] : [] }));
    activeService = wantedService();
    services = [];
    wt.select(activeService);
    usb.flushStream();
    const options = decoderOptions();
    playingAudio = JSON.stringify({ audio: options.audio, dualMono: options.dualMono });
    await player.start(options);
    await wt.start(onData, onServices);
    setMessage('');
    restarts = 0;
    acquireWakeLock();
  } catch (error) {
    log(`選局に失敗: ${error.message || error}`);
    setMessage(`選局に失敗しました: ${error.message || error}`);
  } finally {
    busy = false;
  }
}

function showSignal(status) {
  if (!status) return;
  if (!status.locked) { setChip('chip-signal', '信号なし', 'bad'); return; }
  const cnr = typeof status.cnr === 'number' ? `${status.cnr.toFixed(1)}dB` : 'ロック';
  setChip('chip-signal', `C/N ${cnr}`, status.cnr === undefined || status.cnr >= 18 ? 'ok' : 'warn');
}

async function poll() {
  if (!attached || busy || scanning) return;
  try {
    const status = await wt.status();
    showSignal(status);
    const now = performance.now();
    const bytes = status.bytes || 0;
    const mbps = lastStatusAt && bytes >= lastBytes ? ((bytes - lastBytes) * 8) / ((now - lastStatusAt) * 1000) : 0;
    lastBytes = bytes;
    lastStatusAt = now;
    if (status.pipeline) {
      const p = JSON.parse(status.pipeline);
      if (p.ecmError) {
        setChip('chip-card', 'カード エラー', 'bad');
        if (!$('overlay-message').textContent) setMessage(p.ecmError);
      } else if (p.haveKeys) {
        setChip('chip-card', 'カードOK', 'ok');
      }
    }
    const info = player.info();
    const parts = [];
    if (status.streaming) parts.push(`${mbps.toFixed(1)}Mbps`);
    if (status.streaming) parts.push(`${info.fps.toFixed(0)}fps`);
    if (info.buffered > 4 * 1024 * 1024) parts.push('デコードが追いついていません');
    $('stats').textContent = parts.join(' · ');
  } catch (error) {
    log(`状態の取得に失敗: ${error.message || error}`);
  }
}

// ---- scan -----------------------------------------------------------------
//
// A scan can be paused: each channel's result is saved as it completes, along
// with where to go on from, so the scan picks up there next time (by itself
// once connected, when nothing is playing). Channels found so far are listed
// and playable straight away.

const SCAN_STORE = 'weborne.scan';
let scanPause = false;
let scanFinished = Promise.resolve();

function loadScan() {
  try {
    const saved = JSON.parse(localStorage.getItem(SCAN_STORE) || 'null');
    if (saved && saved.next >= UHF_FIRST && saved.next <= UHF_LAST) return saved;
  } catch { /* ignore */ }
  return null;
}

function saveScan(state) {
  try {
    if (state) localStorage.setItem(SCAN_STORE, JSON.stringify(state));
    else localStorage.removeItem(SCAN_STORE);
  } catch { /* ignore */ }
}

function renderScanButton() {
  const saved = loadScan();
  $('scan').textContent = saved ? `スキャン再開（${saved.next}ch〜）` : 'チャンネルスキャン';
  $('scan-restart').hidden = !saved || scanning;
}

// Asks a running scan to pause and waits until it has.
async function pauseScan() {
  if (!scanning) return;
  scanPause = true;
  await scanFinished;
}

async function scan({ fromStart = false } = {}) {
  if (!attached) { await connect(); if (!attached) return; }
  if (busy || scanning) return;
  let state = fromStart ? null : loadScan();
  if (!state) {
    // A fresh scan replaces the list as it goes.
    state = { next: UHF_FIRST };
    channels = [];
    saveChannels();
  }
  saveScan(state);
  scanning = true;
  scanPause = false;
  let finish;
  scanFinished = new Promise((resolve) => { finish = resolve; });
  $('scan-progress').hidden = false;
  $('scan').disabled = true;
  renderScanButton();
  await player.stop();
  await wt.stop();
  current = null;
  renderChannels();
  setMessage(`チャンネルスキャン中（${state.next}chから）。局を押すと中断して再生します`);
  try {
    for (let ch = state.next; ch <= UHF_LAST && !scanPause; ch++) {
      const progress = (ch - UHF_FIRST) / (UHF_LAST - UHF_FIRST + 1);
      $('scan-fill').style.width = `${(progress * 100).toFixed(0)}%`;
      $('scan-text').textContent = `${ch}chを確認中… 見つかった数${channels.length}`;
      let status = null;
      try {
        // An empty channel need not be waited on as long as one being watched.
        status = await wt.tune(frequencyOf(ch), 1200);
      } catch (error) {
        log(`${ch}ch: ${error.message || error}`);
      }
      if (status && status.locked) {
        // Read the SDT for the names.
        let named = null;
        await wt.start(() => {}, (json) => {
          const list = JSON.parse(json);
          if (list.some((s) => s.name)) named = list;
        });
        const deadline = performance.now() + 6000;
        while (!named && performance.now() < deadline && !scanPause) {
          await new Promise((r) => setTimeout(r, 200));
        }
        await wt.stop();
        // Paused before the names came: this channel is done again next time.
        if (!named && scanPause) break;
        const entry = {
          ch,
          freq: frequencyOf(ch),
          name: '',
          services: (named || []).map(({ id, name, codec }) => ({ id, name, codec })),
        };
        channels = channels.filter((c) => c.ch !== ch).concat(entry).sort((a, b) => a.ch - b.ch);
        saveChannels();
        renderChannels();
        log(`${ch}ch: ${channelLabel(entry)} (C/N ${status.cnr ? status.cnr.toFixed(1) : '?'}dB)`);
      }
      state.next = ch + 1;
      saveScan(state.next <= UHF_LAST ? state : null);
    }
  } finally {
    const paused = !!loadScan();
    scanning = false;
    $('scan-progress').hidden = true;
    $('scan').disabled = false;
    renderScanButton();
    renderChannels();
    if (paused) {
      setMessage(`スキャンを中断しました（${loadScan().next}chから再開します）`);
    } else {
      setMessage(channels.length ? `${channels.length}局見つかりました。チャンネルを選んでください` : 'チャンネルが見つかりませんでした。アンテナの接続を確認してください');
    }
    finish();
  }
}

// ---- screen ---------------------------------------------------------------

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not allowed now */ }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release();
  wakeLock = null;
}

async function toggleFullscreen() {
  const stage = $('stage');
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  try {
    await stage.requestFullscreen({ navigationUI: 'hide' });
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape').catch(() => {});
  } catch (error) {
    log(`全画面にできません: ${error.message || error}`);
  }
}

// ---- start ----------------------------------------------------------------

// Settings saved under the old name (webtorne) carry over.
function migrateStorage() {
  try {
    for (const key of ['channels', 'quality', 'scan']) {
      const old = localStorage.getItem(`webtorne.${key}`);
      if (old !== null && localStorage.getItem(`weborne.${key}`) === null) localStorage.setItem(`weborne.${key}`, old);
      localStorage.removeItem(`webtorne.${key}`);
    }
  } catch { /* ignore */ }
}

async function main() {
  migrateStorage();
  channels = loadChannels();
  renderChannels();
  if (!('usb' in navigator)) {
    setMessage('このブラウザはWebUSBに対応していません。AndroidまたはPCのChromeで開いてください');
    $('connect').disabled = true;
    return;
  }
  if (!window.isSecureContext) {
    setMessage('HTTPS（またはlocalhost）で開いてください。WebUSBは安全な接続でしか使えません');
    $('connect').disabled = true;
    return;
  }
  if (!(await ensureIsolated())) {
    setMessage('このページを分離モードで開けませんでした（SharedArrayBufferが使えません）。再読み込みしてください');
    sessionStorage.removeItem('weborne.coi-reloaded');
    $('connect').disabled = true;
    return;
  }
  sessionStorage.removeItem('weborne.coi-reloaded');

  player = new Player($('screen'), {
    onLog: log,
    onState: (state) => {
      if (state.tracks && state.tracks.video) {
        log(`映像${state.tracks.video.width}x${state.tracks.video.height}${state.tracks.audio ? ' / 音声あり' : ''}`);
      }
      if (state.ended !== undefined && !state.requested && current && !busy && !scanning && attached) {
        // ffmpeg gave up (a broken stream): start it again, but not forever.
        if (restarts++ < 5) {
          log(`デコーダが終了しました(code ${state.ended})。再起動します`);
          setTimeout(() => { if (current && !busy && !player.running) player.start(decoderOptions()); }, 500);
        }
      }
    },
  });
  // For debugging from the console: weborneDebug.player.push(bytes) etc.
  window.weborneDebug = { player, log };
  setMessage('読み込み中…');
  $('connect').disabled = true;
  try {
    [wt] = await Promise.all([loadGo(), player.ready]);
  } catch (error) {
    setMessage(`読み込みに失敗しました: ${error.message || error}`);
    return;
  }
  $('connect').disabled = false;
  setMessage('torneをUSBで接続して「接続」を押してください');

  $('connect').addEventListener('click', connect);
  $('scan').addEventListener('click', () => scan());
  $('scan-restart').addEventListener('click', () => scan({ fromStart: true }));
  $('scan-cancel').addEventListener('click', () => { scanPause = true; });
  renderScanButton();
  $('fullscreen').addEventListener('click', toggleFullscreen);
  $('stage').addEventListener('dblclick', toggleFullscreen);
  // The bar over the picture works as on YouTube: a tap shows it and the
  // next tap hides it, a mouse move shows it, and it hides by itself after a
  // few seconds without use. Using the bar itself keeps it up.
  const stage = $('stage');
  let controlsTimer = 0;
  const hideControls = () => { clearTimeout(controlsTimer); stage.classList.remove('show-controls'); };
  const showControls = () => {
    stage.classList.add('show-controls');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(hideControls, 3000);
  };
  stage.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.stage-controls')) { showControls(); return; }
    if (event.pointerType === 'mouse') { showControls(); return; }
    if (stage.classList.contains('show-controls')) hideControls();
    else showControls();
  });
  stage.addEventListener('pointermove', (event) => { if (event.pointerType === 'mouse') showControls(); });
  stage.addEventListener('mouseleave', hideControls);
  $('volume').addEventListener('input', showControls);
  document.addEventListener('fullscreenchange', hideControls);
  $('volume').addEventListener('input', (e) => player.setVolume(Number(e.target.value)));
  $('mute').addEventListener('click', () => {
    player.setMuted(!player.muted);
    $('mute').textContent = player.muted ? '🔇' : '🔊';
  });
  $('deinterlace').addEventListener('change', (e) => { player.deinterlace = e.target.checked; });
  $('quality').addEventListener('change', () => {
    try { localStorage.setItem('weborne.quality', quality()); } catch { /* ignore */ }
    if (!current || busy) return;
    activeService = wantedService();
    wt.select(activeService);
    restartPlayer();
  });
  $('audio-mode').addEventListener('change', () => {
    try { localStorage.setItem('weborne.audio', audioMode()); } catch { /* ignore */ }
    if (current && !busy) restartPlayer();
  });
  try {
    const savedAudio = localStorage.getItem('weborne.audio');
    if (savedAudio) $('audio-mode').value = savedAudio;
  } catch { /* ignore */ }
  $('service').addEventListener('change', (e) => {
    chosenService = Number(e.target.value);
    if (!current) return;
    activeService = wantedService();
    wt.select(activeService);
    restartPlayer();
  });
  try {
    const saved = localStorage.getItem('weborne.quality');
    if (saved) $('quality').value = saved;
  } catch { /* ignore */ }

  navigator.usb.addEventListener('disconnect', (event) => {
    if (usb && event.device === usb.device) disconnected();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current) acquireWakeLock();
  });
  window.addEventListener('pagehide', () => { if (attached) wt.release(); });
  setInterval(poll, 1000);

  // Already allowed and plugged in: connect straight away.
  if (await TorneUSB.known()) connect();
}

main();
