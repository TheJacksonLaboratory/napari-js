// 3D scatter: instanced screen-facing billboards at 3D positions, sized in screen pixels, with an
// antialiased disc SDF and per-point value → windowed → gamma → colormap LUT. Depth is written at
// the point's center depth so points occlude correctly under the orbit camera. Premultiplied output.
//
// Each instance also carries a per-point alpha and size multiplier. Both default to 1 on the CPU
// side, so a layer that sets neither renders exactly as it did before they existed — but with them
// a host can mute or enlarge a subset in ONE layer, instead of splitting the cloud into two draws
// that then depth-sort against each other.
export const POINTS3D_SHADER = /* wgsl */ `
struct U {
  mvp : mat4x4<f32>,
  params : vec4<f32>,   // viewportW, viewportH, sizePx, opacity
  window : vec4<f32>,   // lo, hi, gamma, 0
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var lutSampler : sampler;
@group(0) @binding(2) var lut : texture_2d<f32>;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) value : f32,
  @location(2) alpha : f32,
};

@vertex
fn vs(
  @builtin(vertex_index) vi : u32,
  @location(0) pos : vec3<f32>,
  @location(1) value : f32,
  @location(2) alpha : f32,
  @location(3) sizeScale : f32,
) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let c = corners[vi];
  var clip = u.mvp * vec4<f32>(pos, 1.0);
  // Offset the corner by a screen-pixel radius: 1 NDC unit spans viewport/2 px, and the divide by w
  // happens after, so pre-multiply by clip.w. sizePx is the diameter (half = sizePx * 0.5).
  let px = u.params.z * max(sizeScale, 0.0);
  clip.x = clip.x + c.x * (px / u.params.x) * clip.w;
  clip.y = clip.y + c.y * (px / u.params.y) * clip.w;
  var out : VSOut;
  out.position = clip;
  out.local = c;
  out.value = value;
  out.alpha = alpha;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let d = length(in.local);            // disc SDF
  let aa = max(fwidth(d), 1e-5);
  let inside = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  if (inside <= 0.0) { discard; }

  let lo = u.window.x;
  let hi = u.window.y;
  let t = clamp((in.value - lo) / max(hi - lo, 1e-6), 0.0, 1.0);
  let g = pow(t, u.window.z);
  let rgb = textureSample(lut, lutSampler, vec2<f32>(g, 0.5)).rgb;

  // Per-point alpha MULTIPLIES the layer opacity rather than replacing it, so the layer-wide
  // control still works on a cloud that also mutes a subset.
  let a = inside * u.params.w * clamp(in.alpha, 0.0, 1.0);
  if (a <= 0.0) { discard; }            // a fully muted point writes no depth over its neighbours
  return vec4<f32>(rgb * a, a);         // premultiplied
}
`;
