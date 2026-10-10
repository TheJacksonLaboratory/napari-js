import { WINDOW_EPSILON } from '../color/display-pipeline';

// Polygon rings drawn as a line-list (boundaries) or a triangle-list (interiors).
// One vertex = a data-space position plus the scalar of the shape it belongs to; the
// scalar is windowed, gamma-corrected and looked up in the same 256-entry LUT the
// image/surface visuals use. `color.w` picks the colour source: 0 = a flat colour,
// 1 = the value through the LUT, 2 = per-shape RGBA from `faceColors`, indexed by the
// vertex scalar (which then carries the shape index; see ShapesLayer.buildVertexValues).
// Premultiplied output for the canvas 'premultiplied' alpha mode.
export const SHAPES_SHADER = /* wgsl */ `
struct U {
  mvp : mat4x4<f32>,
  // lo, hi, gamma, opacity
  window : vec4<f32>,
  // flatColor rgb + mode (0 = flat colour, 1 = colormap the value, 2 = faceColors[shape])
  color : vec4<f32>,
  // flat alpha, unused, unused, unused
  extra : vec4<f32>,
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var lutSampler : sampler;
@group(0) @binding(2) var lut : texture_2d<f32>;
// Per-shape straight RGBA; a one-element placeholder unless mode == 2.
@group(0) @binding(3) var<storage, read> faceColors : array<vec4<f32>>;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) value : f32,
};

@vertex
fn vs(@location(0) pos : vec2<f32>, @location(1) value : f32) -> VSOut {
  var out : VSOut;
  out.position = u.mvp * vec4<f32>(pos, 0.0, 1.0);
  out.value = value;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let opacity = u.window.w;
  var rgb : vec3<f32>;
  var alpha = u.extra.x;
  if (u.color.w > 1.5) {
    // Per-shape colour. The index is constant across a shape; round() absorbs the
    // interpolator's rounding.
    let c = faceColors[u32(round(in.value))];
    rgb = c.rgb;
    alpha = clamp(c.a, 0.0, 1.0);
  } else if (u.color.w < 0.5) {
    rgb = u.color.rgb;
  } else {
    let lo = u.window.x;
    let hi = u.window.y;
    // windowGamma()'s epsilon, so ShapesLayer.colorAt() matches a very narrow window too.
    let t = clamp((in.value - lo) / max(hi - lo, ${WINDOW_EPSILON}), 0.0, 1.0);
    let g = pow(t, u.window.z);
    rgb = textureSampleLevel(lut, lutSampler, vec2<f32>(g, 0.5), 0.0).rgb;
  }
  let a = alpha * opacity;
  if (a <= 0.0) { discard; }
  return vec4<f32>(rgb * a, a);
}
`;
