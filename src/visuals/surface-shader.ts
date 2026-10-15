import { MAX_CLIPPING_PLANES } from '../layers/clipping';

// Triangle-mesh surface: per-vertex scalar → windowed → invert → gamma → colormap LUT (or one
// colour, or a colour per vertex: flags.z = 0, 1, 2), with two-sided flat shading, cut by up to
// MAX_CLIPPING_PLANES clipping planes. Normals are derived per-fragment from screen-space
// derivatives of world position (dpdx/dpdy), so no per-vertex normals or normal matrix are needed.
// Premultiplied output for the canvas 'premultiplied' alpha mode. Depth is written by the pipeline
// (see surface-visual.ts).
export const SURFACE_SHADER = /* wgsl */ `
struct U {
  mvp : mat4x4<f32>,
  params : vec4<f32>,   // lo, hi, gamma, opacity
  light : vec4<f32>,    // lightDir.xyz (world, toward viewer), ambient
  flags : vec4<f32>,    // wireframe (0/1), invert (0/1), colour mode (0 colormap, 1 color, 2 vertex), clipping planes
  color : vec4<f32>,    // the layer colour (colour mode 1), straight RGBA
  planes : array<vec4<f32>, ${2 * MAX_CLIPPING_PLANES}>, // per clipping plane: position.xyz, 0; unit normal.xyz, 0
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var lutSampler : sampler;
@group(0) @binding(2) var lut : texture_2d<f32>;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) value : f32,
  @location(2) color : vec4<f32>,
};

// vcolor comes from a second buffer: per vertex (colour mode 2), else one dummy element read by
// every vertex (array stride 0).
@vertex
fn vs(@location(0) pos : vec3<f32>, @location(1) value : f32, @location(2) vcolor : vec4<f32>) -> VSOut {
  var out : VSOut;
  out.position = u.mvp * vec4<f32>(pos, 1.0);
  out.worldPos = pos;
  out.value = value;
  out.color = vcolor;
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
  // Sampled in every mode, in uniform control flow; the mode only picks among the colours.
  var c = vec4<f32>(textureSample(lut, lutSampler, vec2<f32>(g, 0.5)).rgb, 1.0);
  if (u.flags.z > 1.5) {
    c = in.color;
  } else if (u.flags.z > 0.5) {
    c = u.color;
  }

  // Clipping planes (vertex coordinates): kept where dot(p - position, normal) >= 0 for every one.
  // Tested last, so the derivatives and the LUT sample above stay in uniform control flow.
  var clipped = false;
  let planeCount = i32(u.flags.w);
  for (var i = 0; i < planeCount; i++) {
    if (dot(in.worldPos - u.planes[2 * i].xyz, u.planes[2 * i + 1].xyz) < 0.0) {
      clipped = true;
    }
  }
  if (clipped) {
    discard;
  }

  let a = clamp(c.a, 0.0, 1.0) * u.params.w; // colour alpha × opacity
  return vec4<f32>(c.rgb * shade * a, a);    // premultiplied
}
`;
