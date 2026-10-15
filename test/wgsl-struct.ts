// Not a test: a helper for tests that check a shader's uniform struct against what its visual packs.

/** Floats in the WGSL uniform struct `U` (mat4x4 → 16, vec4 → 4, array<vec4<f32>, N> → 4N). */
export function uniformStructFloats(shader: string): number {
  const body = /struct U \{([\s\S]*?)\};/.exec(shader)?.[1] ?? '';
  let n = 0;
  for (const line of body.split('\n')) {
    const type = line.split('//')[0].split(':')[1]?.trim();
    if (!type) continue;
    if (type.startsWith('mat4x4')) n += 16;
    else if (type.startsWith('vec4')) n += 4;
    else {
      const arr = /array<vec4<f32>,\s*(\d+)>/.exec(type);
      if (!arr) throw new Error(`Unexpected uniform type: ${type}`);
      n += 4 * Number(arr[1]);
    }
  }
  return n;
}
