// Triangle-mesh surface: per-vertex scalar → windowed → invert → gamma → colormap LUT, with two-sided
// flat shading. Normals are derived per-fragment from screen-space derivatives of world position
// (dpdx/dpdy), so no per-vertex normals or normal matrix are needed. Premultiplied output for the
// canvas 'premultiplied' alpha mode. Depth is written by the pipeline (see surface-visual.ts).
export const SURFACE_SHADER = /* wgsl */ `
struct U {
  mvp : mat4x4<f32>,
  params : vec4<f32>,   // lo, hi, gamma, opacity
  light : vec4<f32>,    // lightDir.xyz (world, toward viewer), ambient
  flags : vec4<f32>,    // wireframe (0/1), invert (0/1), 0, 0
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var lutSampler : sampler;
@group(0) @binding(2) var lut : texture_2d<f32>;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) value : f32,
};

@vertex
fn vs(@location(0) pos : vec3<f32>, @location(1) value : f32) -> VSOut {
  var out : VSOut;
  out.position = u.mvp * vec4<f32>(pos, 1.0);
  out.worldPos = pos;
  out.value = value;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  // Flat face normal from the world-position gradient across the triangle (kept in uniform control
  // flow so the derivative builtins are always evaluated). Wireframe lines are drawn fullbright,
  // since screen-space derivatives are ill-defined for line primitives.
  let n = normalize(cross(dpdx(in.worldPos), dpdy(in.worldPos)));
  let L = normalize(u.light.xyz);
  let ambient = u.light.w;
  let diffuse = abs(dot(n, L));            // abs → light both faces (two-sided mesh)
  let shade = select(ambient + (1.0 - ambient) * diffuse, 1.0, u.flags.x > 0.5);

  let lo = u.params.x;
  let hi = u.params.y;
  // window → invert → gamma, the order of windowGamma() and the image shader.
  var t = clamp((in.value - lo) / max(hi - lo, 1e-6), 0.0, 1.0);
  if (u.flags.y > 0.5) { t = 1.0 - t; }
  let g = pow(t, u.params.z);               // gamma
  let rgb = textureSample(lut, lutSampler, vec2<f32>(g, 0.5)).rgb * shade;

  let a = u.params.w;                        // opacity
  return vec4<f32>(rgb * a, a);              // premultiplied
}
`;
