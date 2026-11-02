// WebUSB wrapper the Go side (weborne.wasm) drives the CECH-ZD1 J through.
//
// Bulk IN endpoints are read by transfers kept outstanding all the time, into a
// queue: the bridge expects a read to time out without losing what arrives
// later, which a single abandoned WebUSB transfer would not give it (WebUSB
// transfers have no timeout, and a cancelled one may still swallow a packet).

export const TORNE_FILTER = { vendorId: 0x054c, productId: 0x04b2 };

class InQueue {
  constructor(device, endpoint, size, depth) {
    this.device = device;
    this.endpoint = endpoint & 0x0f;
    this.size = size;
    this.depth = depth;
    this.chunks = [];
    this.waiters = [];
    this.error = null;
    this.running = true;
    this.pending = [];
    for (let i = 0; i < depth; i++) this.submit();
  }

  submit() {
    if (!this.running) return;
    const transfer = this.device.transferIn(this.endpoint, this.size);
    this.pending.push(transfer);
    transfer.then(
      (result) => {
        this.pending.shift();
        if (result.status === 'stall') {
          this.device.clearHalt('in', this.endpoint).catch(() => {});
        } else if (result.data && result.data.byteLength > 0) {
          this.chunks.push(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
          // Nobody is reading (the page is busy or the stream was left
          // running): keep the newest few seconds only.
          if (this.chunks.length > 256) this.chunks.splice(0, this.chunks.length - 256);
          this.wake();
        }
        this.submit();
      },
      (error) => {
        this.pending.shift();
        if (!this.running) return;
        this.error = error;
        this.running = false;
        this.wake();
      },
    );
  }

  wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  // Resolves to up to max bytes, or null when nothing arrived in time.
  async read(max, timeoutMs) {
    if (this.chunks.length === 0) {
      if (this.error) throw this.error;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = this.waiters.indexOf(done);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve();
        }, Math.max(timeoutMs, 1));
        const done = () => { clearTimeout(timer); resolve(); };
        this.waiters.push(done);
      });
      if (this.chunks.length === 0) {
        if (this.error) throw this.error;
        return null;
      }
    }
    // Hand over as much as fits, keeping each chunk's tail for the next read.
    const parts = [];
    let total = 0;
    while (this.chunks.length && total < max) {
      const head = this.chunks[0];
      const take = Math.min(head.byteLength, max - total);
      parts.push(head.subarray(0, take));
      total += take;
      if (take === head.byteLength) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      // A message endpoint gives one transfer per read.
      if (this.depth === 1) break;
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
    return out;
  }

  flush() { this.chunks = []; }
  stop() { this.running = false; }
}

const RECIPIENTS = ['device', 'interface', 'endpoint', 'other'];
const TYPES = ['standard', 'class', 'vendor'];

function setup(requestType, request, value, index) {
  return {
    requestType: TYPES[(requestType >> 5) & 3],
    recipient: RECIPIENTS[requestType & 0x1f],
    request, value, index,
  };
}

export class TorneUSB {
  constructor(device) {
    this.device = device;
    this.queues = new Map();
  }

  static async request() {
    return navigator.usb.requestDevice({ filters: [TORNE_FILTER] });
  }

  static async known() {
    const devices = await navigator.usb.getDevices();
    return devices.find((d) => d.vendorId === TORNE_FILTER.vendorId && d.productId === TORNE_FILTER.productId) || null;
  }

  async open() {
    const d = this.device;
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    await d.claimInterface(0);
    await d.selectAlternateInterface(0, 0);
  }

  async close() {
    for (const q of this.queues.values()) q.stop();
    this.queues.clear();
    try { await this.device.close(); } catch { /* already gone */ }
  }

  queue(endpoint) {
    let q = this.queues.get(endpoint);
    if (!q) {
      // 0x81 is the transport stream: keep a deep ring of large transfers.
      // Other IN endpoints carry short messages.
      q = endpoint === 0x81
        ? new InQueue(this.device, endpoint, 64 * 1024, 8)
        : new InQueue(this.device, endpoint, 512, 1);
      this.queues.set(endpoint, q);
    }
    return q;
  }

  flushStream() {
    const q = this.queues.get(0x81);
    if (q) q.flush();
  }

  // The methods below are what the Go side calls.

  async controlIn(requestType, request, value, index, length) {
    const result = await this.device.controlTransferIn(setup(requestType, request, value, index), length);
    if (result.status !== 'ok') throw new Error(`controlIn ${result.status}`);
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  }

  async controlOut(requestType, request, value, index, data) {
    const result = await this.device.controlTransferOut(setup(requestType, request, value, index), data);
    if (result.status !== 'ok') throw new Error(`controlOut ${result.status}`);
    return result.bytesWritten;
  }

  bulkIn(endpoint, length, timeoutMs) {
    return this.queue(endpoint).read(length, timeoutMs);
  }

  async bulkOut(endpoint, data) {
    const result = await this.device.transferOut(endpoint & 0x0f, data);
    if (result.status !== 'ok') throw new Error(`bulkOut ${result.status}`);
    return result.bytesWritten;
  }
}
