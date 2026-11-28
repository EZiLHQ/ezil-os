// A bounded seekable single-cluster WebM, for one short recording segment of VP8 video without audio.
const utf8 = new TextEncoder();
const concat = arrays => {
  const length = arrays.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of arrays) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
};

function unsigned(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('invalid_ebml_unsigned');
  const bytes = [];
  do { bytes.unshift(value % 256); value = Math.floor(value / 256); } while (value > 0);
  return Uint8Array.from(bytes);
}

function sizeOf(value) {
  let width = 1;
  while (value >= 2 ** (width * 7) - 1) width++;
  const bytes = new Uint8Array(width);
  const integer = unsigned(value);
  bytes.set(integer, width - integer.length);
  bytes[0] |= 1 << (8-width);
  return bytes;
}

function element(id, contents) { return concat([unsigned(id), sizeOf(contents.length), contents]); }
const uint = (id, n) => element(id, unsigned(n));
const text = (id, s) => element(id, utf8.encode(s));
const group = (id, parts) => element(id, concat(parts));
function milliseconds(n) {
  const bytes = new ArrayBuffer(8);
  new DataView(bytes).setFloat64(0, n, false);
  return element(0x4489, new Uint8Array(bytes));
}

export function createVP8Muxer(width, height) {
  let totalBytes = 0, previous = -1;
  const blocks = [];
  return {
    addVideoChunk(chunk) {
      const t = Math.round(chunk.timestamp / 1000);
      if (t <= previous || t > 30000 || blocks.length >= 32 || !Number.isSafeInteger(t)
          || (!blocks.length && (t !== 0 || chunk.type !== 'key'))) throw Error('invalid_segment_sample');
      totalBytes += chunk.byteLength;
      if (totalBytes > 8 * 1024 * 1024) throw Error('segment_limit');
      const header = Uint8Array.from([0x81,t >> 8,t & 255,chunk.type === 'key' ? 0x80 : 0]);
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload); blocks.push({time:t, bytes:element(0xa3,concat([header,payload]))}); previous=t;
    },
    finalize(durationMs) {
      if (!blocks.length || durationMs <= 0 || durationMs > 32000) throw Error('invalid_segment_duration');
      const header=group(0x1a45dfa3,[uint(0x4286,1),uint(0x42f7,1),uint(0x42f2,4),uint(0x42f3,8),text(0x4282,'webm'),uint(0x4287,4),uint(0x4285,2)]);
      const info=group(0x1549a966,[uint(0x2ad7b1,1000000),milliseconds(durationMs),text(0x4d80,'EZiL'),text(0x5741,'EZiL')]);
      const track=group(0xae,[uint(0xd7,1),uint(0x73c5,1),uint(0x83,1),text(0x86,'V_VP8'),uint(0x23e383,1000000000),group(0xe0,[uint(0xb0,width),uint(0xba,height)])]);
      const tracks=group(0x1654ae6b,[track]);
      const cluster=group(0x1f43b675,[uint(0xe7,0),...blocks.filter(block => block.time < durationMs).map(block => block.bytes)]);
      const cues=group(0x1c53bb6b,[group(0xbb,[uint(0xb3,0),group(0xb7,[uint(0xf7,1),uint(0xf1,info.length+tracks.length)])])]);
      return concat([header,group(0x18538067,[info,tracks,cluster,cues])]).buffer;
    }
  };
}
