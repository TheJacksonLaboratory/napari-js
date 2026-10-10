// Image display pipeline: window → invert → gamma → colormap LUT (scalar), or direct
// window/gamma (RGBA). A scalar pixel's alpha is the LUT's alpha (RGBA colormap stops) ×
// opacity, and 0 under transparentBelow when raw ≤ climLo. CPU reference: mapScalarRGBA. Output is premultiplied to match the canvas 'premultiplied' alpha
// mode. Ported from napari's image display path (see docs/04-wgsl-rendering-plan.md).
export const IMAGE_COLORMAP_SHADER = /* wgsl */ `
struct U {
  mvp : mat4x4<f32>,
  imageSize : vec2<f32>,
  origin : vec2<f32>,   // data-space origin of this quad (0 for a full image; tile origin for tiles)
  params : vec4<f32>,   // climLo, climHi, gamma, opacity   (clim already normalized to sample space)
  flags : vec4<f32>,    // isRgba, invert, transparentBelow, 0
};

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var srcSamp : sampler;
@group(0) @binding(2) var srcTex : texture_2d<f32>;
@group(0) @binding(3) var lutSamp : sampler;
@group(0) @binding(4) var lutTex : texture_2d<f32>;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  );
  let c = corners[vi];
  var out : VSOut;
  out.position = u.mvp * vec4<f32>(u.origin + c * u.imageSize, 0.0, 1.0);
  out.uv = c;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let raw = textureSample(srcTex, srcSamp, in.uv);
  let climLo = u.params.x;
  let climHi = u.params.y;
  let gamma = u.params.z;
  let opacity = u.params.w;
  let denom = max(climHi - climLo, 1e-8);

  // Scalar path: window → invert → gamma → LUT.
  var t = clamp((raw.r - climLo) / denom, 0.0, 1.0);
  if (u.flags.y > 0.5) { t = 1.0 - t; }
  t = pow(t, gamma);
  let lut = textureSample(lutTex, lutSamp, vec2<f32>(t, 0.5));
  let mapped = lut.rgb;
  // Compared before invert, in the same (normalized sample) units as climLo.
  let below = u.flags.z > 0.5 && raw.r <= climLo;
  let scalarA = select(lut.a * opacity, 0.0, below);

  // RGB path: per-channel window → gamma.
  var direct = clamp((raw.rgb - vec3<f32>(climLo)) / vec3<f32>(denom), vec3<f32>(0.0), vec3<f32>(1.0));
  direct = pow(direct, vec3<f32>(gamma));

  let isRgba = u.flags.x > 0.5;
  let rgb = select(mapped, direct, isRgba);
  let a = select(scalarA, raw.a * opacity, isRgba);
  return vec4<f32>(rgb * a, a);
}
`;
