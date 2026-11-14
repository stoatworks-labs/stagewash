/**
 * A box as a binary glTF, so an exported truss or bar has something to draw.
 *
 * An MVR `<Truss>` must carry geometry, and a receiver given none draws
 * nothing — the rig arrives as fixtures floating in space. Stagewash knows a
 * structure's run and its cross-section and nothing else, so that is exactly
 * what it sends: a plain box along the run. Not a truss model; a placeholder
 * of the right size in the right place.
 *
 * The box runs along +X from 0 to `lengthM` and is centred on the X axis in
 * the other two. That matters because glTF is Y-up and MVR is Z-up: a
 * receiver turns glTF's Y into its Z, and a box that is symmetric about X with
 * a square section comes out identical either way, so there is no orientation
 * for a receiver to get wrong. glTF units are metres by the glTF spec, unlike
 * MVR's own millimetres.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** Box from x = 0 to `lengthM`, `sectionM` square, as a GLB file. */
export function boxGlb(lengthM: number, sectionM: number): Uint8Array {
  const L = Math.max(lengthM, 0.01);
  const h = Math.max(sectionM, 0.01) / 2;

  // Eight corners. Index = (x ? 1 : 0) | (y ? 2 : 0) | (z ? 4 : 0).
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = i & 1 ? L : 0;
    positions[i * 3 + 1] = i & 2 ? h : -h;
    positions[i * 3 + 2] = i & 4 ? h : -h;
  }
  // Twelve triangles, wound counter-clockwise seen from outside.
  const indices = new Uint16Array([
    0, 4, 6, 0, 6, 2, // x = 0
    1, 3, 7, 1, 7, 5, // x = L
    0, 1, 5, 0, 5, 4, // y = -h
    2, 6, 7, 2, 7, 3, // y = +h
    0, 2, 3, 0, 3, 1, // z = -h
    4, 5, 7, 4, 7, 6, // z = +h
  ]);

  const posBytes = positions.byteLength; // 96
  const idxBytes = indices.byteLength; // 72
  const binLength = posBytes + idxBytes;

  const json = {
    asset: { version: '2.0', generator: 'stagewash' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: idxBytes, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 8,
        type: 'VEC3',
        min: [0, -h, -h],
        max: [L, h, h],
      },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = (jsonBytes.length + 3) & ~3;
  const binPadded = (binLength + 3) & ~3;
  const total = 12 + 8 + jsonPadded + 8 + binPadded;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  // The JSON chunk is padded with spaces, the binary chunk with zeros.
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded);

  const binStart = 20 + jsonPadded;
  view.setUint32(binStart, binPadded, true);
  view.setUint32(binStart + 4, CHUNK_BIN, true);
  out.set(new Uint8Array(positions.buffer), binStart + 8);
  out.set(new Uint8Array(indices.buffer), binStart + 8 + posBytes);

  return out;
}
