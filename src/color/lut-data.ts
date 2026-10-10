/**
 * Decode a base64 RGB lookup table (`3 · n` bytes) into a `Uint8Array`. Generated colormap
 * modules store their tables this way: 1 KB of source per 256-entry map, against ~9 KB as
 * numeric literals. Pure; uses `atob` (browsers, workers, Node ≥ 16).
 */
export function decodeLut(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
