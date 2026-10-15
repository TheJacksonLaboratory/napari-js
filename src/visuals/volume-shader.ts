// Single-pass fragment raymarch. A fullscreen quad reconstructs, per pixel, the view ray in
// volume space (via invMVP applied to near/far clip points), intersects the [0,1]^3 box, and
// marches a 3D texture. Modes: MIP, front-to-back translucent DVR, and iso-surface with a
// central-difference gradient + lambert shading. Ported from napari's volume path (docs/04).
//
// Colour follows the image pipeline — window → invert → gamma → LUT, as windowGamma() — but the
// march itself (the MIP maximum, the translucent alpha, the iso threshold) runs on the
// un-inverted windowed value. Inverting those would make the empty space around an object the
// brightest, most opaque thing in the box; inverting only the colour keeps what is drawn and
// changes how it is coloured.
//
// The 'plane' depiction (napari's) and the clipping planes work in data (voxel) coordinates, where
// voxel (i, j, k) is centred on [i, j, k]: texture coordinate × dims − 0.5. Each is a half-space
// along the ray, so it narrows the marched range [tNear, tFar] analytically rather than testing
// every sample. A plane at most one voxel thick is sampled once, where the ray crosses it.
export const VOLUME_SHADER = /* wgsl */ `
struct U {
  invMvp : mat4x4<f32>,
  params : vec4<f32>,   // climLo, climHi (normalized 0..1), gamma, opacity
  params2 : vec4<f32>,  // renderingCode (0=mip,1=translucent,2=iso), isoThreshold, steps, invert
  dims : vec4<f32>,     // width, height, depth (voxels), depiction (0 volume, 1 plane)
  plane : vec4<f32>,    // the depicted plane: unit normal (data coords), -dot(normal, position)
  plane2 : vec4<f32>,   // half thickness (voxels), clipping plane count, 0, 0
  clip : array<vec4<f32>, 6>,  // clipping planes as plane is; a sample is kept where dot(n, p) + w >= 0
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var volSamp : sampler;
@group(0) @binding(2) var volTex : texture_3d<f32>;
@group(0) @binding(3) var lutSamp : sampler;
@group(0) @binding(4) var lut : texture_2d<f32>;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) ndc : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let c = corners[vi];
  var out : VSOut;
  out.position = vec4<f32>(c, 0.0, 1.0);
  out.ndc = c;
  return out;
}

fn unproject(ndc : vec2<f32>, z : f32) -> vec3<f32> {
  let p = u.invMvp * vec4<f32>(ndc, z, 1.0);
  return p.xyz / p.w;
}

// The windowed sample in 0..1, BEFORE gamma: what the colour is mapped from.
fn sampleT(pos : vec3<f32>) -> f32 {
  let s = textureSampleLevel(volTex, volSamp, pos, 0.0).r;
  let lo = u.params.x;
  let hi = u.params.y;
  return clamp((s - lo) / max(hi - lo, 1e-6), 0.0, 1.0);
}

// Windowed + gamma, un-inverted: what the march projects, accumulates and thresholds.
fn sampleWindowed(pos : vec3<f32>) -> f32 {
  return pow(sampleT(pos), u.params.z);
}

// Texture space [0,1]^3 → data (voxel) coordinates.
fn toData(pos : vec3<f32>) -> vec3<f32> {
  return pos * u.dims.xyz - vec3<f32>(0.5);
}

// Narrow the ray range (x = near, y = far) to where the half-space dot(h.xyz, p) + h.w >= 0 holds;
// an empty result has x > y. ro and rd are in texture space, the half-space in data coordinates.
fn keepHalfSpace(range : vec2<f32>, ro : vec3<f32>, rd : vec3<f32>, h : vec4<f32>) -> vec2<f32> {
  let a = dot(h.xyz, toData(ro)) + h.w;
  let b = dot(h.xyz, rd * u.dims.xyz);
  if (abs(b) < 1e-9) {
    if (a < 0.0) { return vec2<f32>(1.0, 0.0); }
    return range;
  }
  let tc = -a / b;
  if (b > 0.0) { return vec2<f32>(max(range.x, tc), range.y); }
  return vec2<f32>(range.x, min(range.y, tc));
}

fn lutColor(t : f32) -> vec3<f32> {
  return textureSampleLevel(lut, lutSamp, vec2<f32>(clamp(t, 0.0, 1.0), 0.5), 0.0).rgb;
}

// Colour of a windowed sample t: invert → gamma → LUT, the order of windowGamma().
fn shade(t : f32) -> vec3<f32> {
  var x = t;
  if (u.params2.w > 0.5) { x = 1.0 - x; }
  return lutColor(pow(x, u.params.z));
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let ro = unproject(in.ndc, 0.0);          // near point, volume space
  let rf = unproject(in.ndc, 1.0);          // far point
  let rd = rf - ro;

  // Intersect ray with the unit box [0,1]^3 (parameter t along rd).
  let inv = 1.0 / rd;
  let t0 = (vec3<f32>(0.0) - ro) * inv;
  let t1 = (vec3<f32>(1.0) - ro) * inv;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  var range = vec2<f32>(
    max(max(max(tmin.x, tmin.y), tmin.z), 0.0),
    min(min(tmax.x, tmax.y), 1.0 * min(tmax.z, 1.0e9)),
  );
  var steps = i32(u.params2.z);

  if (u.dims.w > 0.5) {
    let half = u.plane2.x;
    if (half > 0.5) {
      // A slab thicker than one voxel: march the part of the ray inside it.
      range = keepHalfSpace(range, ro, rd, vec4<f32>(u.plane.xyz, u.plane.w + half));
      range = keepHalfSpace(range, ro, rd, vec4<f32>(-u.plane.xyz, half - u.plane.w));
    } else {
      // One voxel thick or thinner: the plane itself, sampled once where the ray crosses it (an
      // axis-aligned plane at an integer position lands on voxel centres: exactly that slice).
      let b = dot(u.plane.xyz, rd * u.dims.xyz);
      if (abs(b) < 1e-9) { discard; }
      let tp = -(dot(u.plane.xyz, toData(ro)) + u.plane.w) / b;
      if (tp < range.x || tp > range.y) { discard; }
      range = vec2<f32>(tp, tp);
      steps = 1;
    }
  }
  if (range.y < range.x || (steps > 1 && range.y == range.x)) { discard; }

  let tNear = range.x;
  let tFar = range.y;
  let dt = (tFar - tNear) / f32(steps);
  let mode = u.params2.x;
  let opacity = u.params.w;

  var maxT = 0.0;
  var col = vec3<f32>(0.0);
  var acc = 0.0;

  for (var i = 0; i < steps; i = i + 1) {
    let t = tNear + (f32(i) + 0.5) * dt;
    let pos = ro + rd * t;
    let tw = sampleT(pos);
    let w = pow(tw, u.params.z);

    if (mode < 0.5) {
      // MIP, on the pre-gamma value: pow is monotonic, so it is the same voxel.
      maxT = max(maxT, tw);
    } else if (mode < 1.5) {
      // Front-to-back translucent DVR
      let a = w * opacity;
      let c = shade(tw);
      col = col + (1.0 - acc) * c * a;
      acc = acc + (1.0 - acc) * a;
      if (acc >= 0.99) { break; }
    } else {
      // Iso-surface: first crossing → gradient + lambert
      if (w >= u.params2.y) {
        let e = 1.0 / 128.0;
        let gx = sampleWindowed(pos + vec3<f32>(e, 0.0, 0.0)) - sampleWindowed(pos - vec3<f32>(e, 0.0, 0.0));
        let gy = sampleWindowed(pos + vec3<f32>(0.0, e, 0.0)) - sampleWindowed(pos - vec3<f32>(0.0, e, 0.0));
        let gz = sampleWindowed(pos + vec3<f32>(0.0, 0.0, e)) - sampleWindowed(pos - vec3<f32>(0.0, 0.0, e));
        let n = normalize(vec3<f32>(gx, gy, gz) + vec3<f32>(1e-5));
        let lightDir = normalize(vec3<f32>(0.5, 0.7, 1.0));
        let lambert = max(dot(n, lightDir), 0.0) * 0.8 + 0.2;
        col = shade(tw) * lambert;
        acc = opacity;
        break;
      }
    }
  }

  if (mode < 0.5) {
    // Emptiness is judged after gamma, as before invert existed: a large gamma that underflows
    // the brightest sample to 0 still leaves the ray empty. shade() takes the pre-gamma value
    // so invert keeps its place ahead of gamma.
    if (pow(maxT, u.params.z) <= 0.0) { discard; }
    col = shade(maxT);
    acc = opacity;
  }
  if (acc <= 0.0) { discard; }
  return vec4<f32>(col * acc, acc);
}
`;
