/// <reference types="vite/client" />

import { afterAll, beforeAll, expect, it } from 'vitest';

import { acquireDevice } from '../../src';
import { describeGpu } from './harness';

// Every WGSL source in the visuals (any `*_SHADER` export of a `*-shader.ts`), so a shader added
// later is compiled here without touching this test.
const modules = import.meta.glob('../../src/visuals/*-shader.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;
const shaders = Object.entries(modules).flatMap(([file, mod]) =>
  Object.entries(mod)
    .filter(([name, code]) => name.endsWith('_SHADER') && typeof code === 'string')
    .map(([name, code]) => ({ name, file: file.replace('../../', ''), code: code as string })),
);

describeGpu('WGSL shaders', () => {
  let device: GPUDevice;
  beforeAll(async () => {
    device = (await acquireDevice()).device;
  });
  afterAll(() => device?.destroy());

  it('finds the visuals’ shaders', () => {
    expect(shaders.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'IMAGE_COLORMAP_SHADER',
        'VOLUME_SHADER',
        'SURFACE_SHADER',
        'POINTS_SHADER',
      ]),
    );
  });

  it.each(shaders.map((s) => [s.name, s] as const))(
    '%s compiles with no errors',
    async (_name, s) => {
      const module = device.createShaderModule({ code: s.code, label: s.name });
      const info = await module.getCompilationInfo();
      const errors = info.messages
        .filter((m) => m.type === 'error')
        .map((m) => `${s.file}:${m.lineNum}:${m.linePos} ${m.message}`);
      expect(errors).toEqual([]);
    },
  );
});
