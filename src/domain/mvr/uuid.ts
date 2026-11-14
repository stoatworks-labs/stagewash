/**
 * Stable UUIDs for exported objects.
 *
 * MVR asks that "all objects used have a persistent unique ID to track changes
 * between the different applications". A random UUID per export would make
 * every re-export look to the receiver like a brand-new rig, so an object's
 * UUID is derived from its stagewash id instead: RFC 4122 version 5 (SHA-1,
 * name-based) under a namespace of stagewash's own. Same rig, same UUIDs,
 * every time; and an object that came *from* an MVR keeps the UUID it arrived
 * with, which is better still.
 *
 * SHA-1 is written out here because the browser only offers it asynchronously
 * (`crypto.subtle`) and Node's `crypto` is not in the browser. This is an
 * identifier, not a security boundary.
 */

/** stagewash's v5 namespace. Generated once; never change it. */
export const STAGEWASH_NAMESPACE = 'a20645ed-2668-4fba-802e-68b3d781c120';

/** RFC 4122's DNS namespace, exported for the test against the RFC's own example. */
export const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function sha1(message: Uint8Array): Uint8Array {
  const ml = message.length;
  const withPadding = ((ml + 9 + 63) >> 6) << 6;
  const data = new Uint8Array(withPadding);
  data.set(message);
  data[ml] = 0x80;
  const view = new DataView(data.buffer);
  // Bit length as a 64-bit big-endian integer; messages here are tiny.
  view.setUint32(withPadding - 4, (ml * 8) >>> 0);
  view.setUint32(withPadding - 8, Math.floor((ml * 8) / 2 ** 32));

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let offset = 0; offset < withPadding; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = (w[i - 3] as number) ^ (w[i - 8] as number) ^ (w[i - 14] as number) ^ (w[i - 16] as number);
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + (w[i] as number)) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => outView.setUint32(i * 4, h));
  return out;
}

/** RFC 4122 §4.3 name-based UUID, version 5. */
export function uuidV5(name: string, namespace: string = STAGEWASH_NAMESPACE): string {
  const ns = uuidBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns);
  input.set(nameBytes, ns.length);
  const hash = sha1(input).slice(0, 16);
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
