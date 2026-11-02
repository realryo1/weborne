// A streaming Matroska reader for exactly what ffmpeg writes here: one raw
// video track (V_UNCOMPRESSED, yuv420p) and one PCM float track, in clusters
// of SimpleBlocks without lacing. Bytes come in arbitrary pieces; blocks come
// out with their time in milliseconds.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
};

const MASTERS = new Set([
  ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Audio, ID.Cluster, ID.BlockGroup,
]);

export class MkvReader {
  // onTracks(tracks) once the track list is known; onBlock(track, timeMs, bytes)
  // for every frame. bytes is a view that is only valid during the call.
  constructor({ onTracks, onBlock }) {
    this.onTracks = onTracks;
    this.onBlock = onBlock;
    this.buffer = new Uint8Array(4 * 1024 * 1024);
    this.start = 0;
    this.end = 0;
    this.scale = 1000000; // ns per tick
    this.clusterTime = 0;
    this.tracks = new Map();
    this.track = null;
    this.announced = false;
  }

  push(bytes) {
    const length = bytes.length;
    if (this.end + length > this.buffer.length) {
      const live = this.end - this.start;
      if (live + length > this.buffer.length) {
        let size = this.buffer.length;
        while (size < live + length) size *= 2;
        const grown = new Uint8Array(size);
        grown.set(this.buffer.subarray(this.start, this.end));
        this.buffer = grown;
      } else {
        this.buffer.copyWithin(0, this.start, this.end);
      }
      this.end = live;
      this.start = 0;
    }
    this.buffer.set(bytes, this.end);
    this.end += length;
    this.parse();
  }

  // Reads an EBML variable-length number at p. Returns [value, length,
  // unknown] or null when more bytes are needed.
  vint(p, keepMarker) {
    if (p >= this.end) return null;
    const first = this.buffer[p];
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && !(first & mask)) { length++; mask >>= 1; }
    if (length > 8) throw new Error('mkv: bad vint');
    if (p + length > this.end) return null;
    let value = keepMarker ? first : first & (mask - 1);
    let allOnes = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < length; i++) {
      const b = this.buffer[p + i];
      value = value * 256 + b;
      if (b !== 0xff) allOnes = false;
    }
    return [value, length, allOnes];
  }

  uint(p, size) {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + this.buffer[p + i];
    return v;
  }

  float(p, size) {
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + p, size);
    return size === 4 ? view.getFloat32(0) : view.getFloat64(0);
  }

  parse() {
    for (;;) {
      const p = this.start;
      const id = this.vint(p, true);
      if (!id) return;
      const size = this.vint(p + id[1], false);
      if (!size) return;
      const header = id[1] + size[1];
      const elementId = id[0];
      if (MASTERS.has(elementId)) {
        this.start = p + header;
        this.enter(elementId);
        continue;
      }
      if (size[2]) throw new Error(`mkv: unknown size on ${elementId.toString(16)}`);
      const total = header + size[0];
      if (p + total > this.end) return;
      this.leaf(elementId, p + header, size[0]);
      this.start = p + total;
    }
  }

  enter(id) {
    if (id === ID.TrackEntry) {
      this.track = { number: 0, type: 0, codec: '', width: 0, height: 0, rate: 0, channels: 0 };
    } else if (id === ID.Cluster) {
      this.announce();
    }
  }

  announce() {
    if (this.announced) return;
    this.announced = true;
    this.onTracks([...this.tracks.values()]);
  }

  leaf(id, p, size) {
    const t = this.track;
    switch (id) {
      case ID.TimestampScale: this.scale = this.uint(p, size); break;
      case ID.TrackNumber:
        t.number = this.uint(p, size);
        this.tracks.set(t.number, t);
        break;
      case ID.TrackType: t.type = this.uint(p, size); break;
      case ID.CodecID: t.codec = new TextDecoder().decode(this.buffer.subarray(p, p + size)); break;
      case ID.PixelWidth: t.width = this.uint(p, size); break;
      case ID.PixelHeight: t.height = this.uint(p, size); break;
      case ID.SamplingFrequency: t.rate = this.float(p, size); break;
      case ID.Channels: t.channels = this.uint(p, size); break;
      case ID.Timestamp: this.clusterTime = this.uint(p, size); break;
      case ID.SimpleBlock:
      case ID.Block: {
        this.announce();
        const track = this.vint(p, false);
        let q = p + track[1];
        let relative = (this.buffer[q] << 8) | this.buffer[q + 1];
        if (relative & 0x8000) relative -= 0x10000;
        const flags = this.buffer[q + 2];
        q += 3;
        if (flags & 0x06) throw new Error('mkv: laced blocks are not supported');
        const ms = ((this.clusterTime + relative) * this.scale) / 1e6;
        this.onBlock(this.tracks.get(track[0]), ms, this.buffer.subarray(q, p + size));
        break;
      }
      default:
        break;
    }
  }
}
