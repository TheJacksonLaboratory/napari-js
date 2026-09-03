// Polygon rings drawn as a line-list (boundaries) or a triangle-list (interiors).
// One vertex = a data-space position plus the scalar of the shape it belongs to; the
// scalar is windowed, gamma-corrected and looked up in the same 256-entry LUT the
// image/surface visuals use. `useValues == 0` bypasses the LUT for a flat colour.
// Premultiplied output for the canvas 'premultiplied' alpha mode.
export const SHAPES_SHADER = /* wgsl */ `
struct U {
  mvp : mat4x4<f32>,
  // lo, hi, gamma, opacity
  window : vec4<f32>,
  // flatColor rgb + useValues (0 = flat colour, 1 = colormap the value)
  color : vec4<f32>,
  // flat alpha, unused, unused, unused
  extra : vec4<f32>,
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var lutSampler : sampler;
@group(0) @binding(2) var lut : texture_2d<f32>;

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
  if (u.color.w < 0.5) {
    rgb = u.color.rgb;
  } else {
    let lo = u.window.x;
    let hi = u.window.y;
    let t = clamp((in.value - lo) / max(hi - lo, 1e-6), 0.0, 1.0);
    let g = pow(t, 1.0 / max(u.window.z, 1e-6));
    rgb = textureSampleLevel(lut, lutSampler, vec2<f32>(g, 0.5), 0.0).rgb;
  }
  let a = u.extra.x * opacity;
  if (a <= 0.0) { discard; }
  return vec4<f32>(rgb * a, a);
}
`;
