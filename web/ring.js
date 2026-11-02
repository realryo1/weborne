// A single-producer, single-consumer byte ring on a SharedArrayBuffer.
// The page writes the transport stream in; the decoder worker, which is
// blocked inside ffmpeg's read(), takes it out with Atomics.wait.
//
// Header (Int32): [0] write position, [1] read position, [2] closed flag,
// [3] bytes dropped because the ring was full.

const HEADER = 16;

export function createRing(size) {
  return new SharedArrayBuffer(HEADER + size);
}

export class Ring {
  constructor(sab) {
    this.header = new Int32Array(sab, 0, 4);
    this.data = new Uint8Array(sab, HEADER);
    this.size = this.data.length;
  }

  reset() {
    Atomics.store(this.header, 0, 0);
    Atomics.store(this.header, 1, 0);
    Atomics.store(this.header, 2, 0);
    Atomics.store(this.header, 3, 0);
  }

  used() {
    const w = Atomics.load(this.header, 0);
    const r = Atomics.load(this.header, 1);
    return (w - r + this.size) % this.size;
  }

  // Producer side. Returns false (and counts the loss) when it does not fit.
  push(bytes) {
    const size = this.size;
    const w = Atomics.load(this.header, 0);
    const free = size - 1 - this.used();
    if (bytes.length > free) {
      Atomics.add(this.header, 3, bytes.length);
      return false;
    }
    const first = Math.min(bytes.length, size - w);
    this.data.set(bytes.subarray(0, first), w);
    if (first < bytes.length) this.data.set(bytes.subarray(first), 0);
    Atomics.store(this.header, 0, (w + bytes.length) % size);
    Atomics.notify(this.header, 0);
    return true;
  }

  close() {
    Atomics.store(this.header, 2, 1);
    Atomics.notify(this.header, 0);
  }

  // Consumer side: blocks until something arrives. Copies up to target.length
  // bytes into target and returns the count, or 0 once closed and drained.
  read(target) {
    const size = this.size;
    for (;;) {
      const w = Atomics.load(this.header, 0);
      const r = Atomics.load(this.header, 1);
      const available = (w - r + size) % size;
      if (available > 0) {
        const n = Math.min(available, target.length);
        const first = Math.min(n, size - r);
        target.set(this.data.subarray(r, r + first), 0);
        if (first < n) target.set(this.data.subarray(0, n - first), first);
        Atomics.store(this.header, 1, (r + n) % size);
        return n;
      }
      if (Atomics.load(this.header, 2)) return 0;
      Atomics.wait(this.header, 0, w, 500);
    }
  }
}
