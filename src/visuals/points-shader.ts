// Instanced point markers with SDF shapes and an antialiased border.
// One instanced quad per point; size/colors/symbol are per-instance vertex attributes, the
// border width and the layer's default symbol are uniforms.
// Premultiplied output for the canvas 'premultiplied' alpha mode.
//
// `symbolDistance` mirrors `pointSymbolDistance` in layers/point-symbols.ts (the CPU
// reference the tests check) — change both together. Symbol codes are indices into
// POINT_SYMBOLS; the switch below is in that order.
export const POINTS_SHADER = /* wgsl */ `
struct U {
  mvp : mat4x4<f32>,
  params : vec4<f32>,   // layer symbol code (POINT_SYMBOLS index), opacity, borderWidth, 0
};
@group(0) @binding(0) var<uniform> u : U;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) local : vec2<f32>,
  @location(1) face : vec4<f32>,
  @location(2) border : vec4<f32>,
  @location(3) borderFrac : f32,
  @location(4) @interpolate(flat) symbol : f32,
};

@vertex
fn vs(
  @builtin(vertex_index) vi : u32,
  @location(0) pos : vec2<f32>,
  @location(1) size : f32,
  @location(2) face : vec4<f32>,
  @location(3) border : vec4<f32>,
  @location(4) symbol : f32,     // per-point code, or < 0 for the layer symbol
) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let c = corners[vi];
  let world = pos + c * (size * 0.5);
  var out : VSOut;
  out.position = u.mvp * vec4<f32>(world, 0.0, 1.0);
  out.local = c;
  out.face = face;
  out.border = border;
  out.borderFrac = clamp(u.params.z / max(size, 1e-6), 0.0, 1.0);
  out.symbol = select(symbol, u.params.x, symbol < 0.0);
  return out;
}

const ARM : f32 = 0.3;          // SYMBOL_ARM
const STAR_INNER : f32 = 0.45;  // SYMBOL_STAR_INNER
const PI : f32 = 3.14159265358979;
const SQRT1_2 : f32 = 0.70710678118654752;

fn sdBox(p : vec2<f32>, b : vec2<f32>) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0);
}

// Regular n-gon, circumradius 1, a vertex on +y (down on screen); flip y to point it up.
fn sdNgon(p : vec2<f32>, n : f32) -> f32 {
  let an = PI / n;
  let acs = vec2<f32>(cos(an), sin(an));
  let a = atan2(p.x, p.y);
  let period = 2.0 * an;
  let bn = a - period * floor(a / period) - an;
  var q = length(p) * vec2<f32>(cos(bn), abs(sin(bn))) - acs;
  q.y = q.y + clamp(-q.y, 0.0, acs.y);
  return length(q) * sign(q.x);
}

fn sdStar5(pIn : vec2<f32>, rf : f32) -> f32 {
  let k1 = vec2<f32>(0.809016994375, -0.587785252292);
  let k2 = vec2<f32>(-k1.x, k1.y);
  var p = vec2<f32>(abs(pIn.x), -pIn.y); // flip, so the top point is up on screen
  p = p - 2.0 * max(dot(k1, p), 0.0) * k1;
  p = p - 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y = p.y - 1.0;
  let ba = rf * vec2<f32>(-k1.y, k1.x) - vec2<f32>(0.0, 1.0);
  let h = clamp(dot(p, ba) / dot(ba, ba), 0.0, 1.0);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

fn sdDiamond(p : vec2<f32>) -> f32 { return (abs(p.x) + abs(p.y) - 1.0) * SQRT1_2; }
fn sdCross(p : vec2<f32>) -> f32 {
  return min(sdBox(p, vec2<f32>(1.0, ARM)), sdBox(p, vec2<f32>(ARM, 1.0)));
}
fn sdArrow(p : vec2<f32>) -> f32 {
  return max(sdDiamond(p), -sdDiamond(p + vec2<f32>(1.0, 0.0)));
}

// 1 + signed distance to the marker edge, in marker radii (< 1 inside, 1 on the edge).
fn symbolDistance(code : u32, p : vec2<f32>) -> f32 {
  switch code {
    case 0u, 1u: { return length(p); }                       // disc, ring
    case 2u: { return max(abs(p.x), abs(p.y)); }              // square
    case 3u: { return 1.0 + sdDiamond(p); }                   // diamond
    case 4u: { return 1.0 + sdStar5(p, STAR_INNER); }         // star
    case 5u: { return 1.0 + sdCross(p); }                     // cross
    case 6u: { return 1.0 + sdCross(vec2<f32>(p.x + p.y, p.y - p.x) * SQRT1_2); } // x
    case 7u: { return 1.0 + sdNgon(vec2<f32>(p.x, -p.y), 3.0); } // triangle_up
    case 8u: { return 1.0 + sdNgon(p, 3.0); }                 // triangle_down
    case 9u: { return 1.0 + sdArrow(p); }                     // arrow
    case 10u: {                                                // tailed_arrow
      return 1.0 + min(sdArrow(p), sdBox(p + vec2<f32>(0.5, 0.0), vec2<f32>(0.5, ARM * 0.6)));
    }
    case 11u: { return 1.0 + sdBox(p, vec2<f32>(1.0, ARM)); } // hbar
    case 12u: { return 1.0 + sdBox(p, vec2<f32>(ARM, 1.0)); } // vbar
    case 13u: {                                                // clobber
      let c = 0.36;
      let r = 0.64;
      let s = 0.86602540378;
      let d1 = length(p + vec2<f32>(0.0, c)) - r;
      let d2 = length(p - vec2<f32>(c * s, c * 0.5)) - r;
      let d3 = length(p + vec2<f32>(c * s, -c * 0.5)) - r;
      return 1.0 + min(d1, min(d2, d3));
    }
    case 14u: { return 1.0 + sdNgon(p.yx, 6.0); }             // hexagon, flat top
    case 15u: { return 1.0 + sdNgon(vec2<f32>(p.x, -p.y), 5.0); } // pentagon, vertex up
    default: { return length(p); }
  }
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let opacity = u.params.y;
  let code = u32(max(in.symbol, 0.0) + 0.5);
  let d = symbolDistance(code, in.local);

  let aa = max(fwidth(d), 1e-5);
  let inside = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  if (inside <= 0.0) { discard; }

  let borderEdge = 1.0 - in.borderFrac;
  let borderMix = smoothstep(borderEdge - aa, borderEdge, d);
  let rgb = mix(in.face.rgb, in.border.rgb, borderMix);
  var a = mix(in.face.a, in.border.a, borderMix);
  if (code == 1u) { a = a * borderMix; } // ring: only the border ring shows
  a = a * inside * opacity;
  return vec4<f32>(rgb * a, a);
}
`;
