// =============================================================================
// territoryGL — WebGL2 fragment-shader renderer for the worktree territory.
//
// The whole `combined` field is a pure function of WORLD position (the domain
// warp and every SDF are evaluated in world space), so a fragment shader can draw
// the full-resolution territory every frame with NO tile cache, NO settle, NO
// coarse mode: pan, zoom, and drag are all just uniform updates + one quad draw.
//
// This reproduces territoryRenderer.ts (the CPU fallback) per-fragment:
//   warp → smin-merged rounded-rect + capsule SDF per group → min over groups →
//   softmax colour blend → two analytic terrace shelves + two contour outlines →
//   panel punch-out. The one non-per-pixel stage (fillEnclosed) arrives as a
//   coarse world-anchored mask texture (see territoryPocketMask).
//
// Visual constants are INJECTED from territoryConfig at build time so the shader
// and the CPU path can never drift.
// =============================================================================

import {
  REACH, CORNER, PANEL_CORNER, SMINK, COLOR_BLEND,
  OUTLINE_WIDTH, OUTLINE_ALPHA, WARP_AMP, WARP_FREQ, INTENSITY,
  MAX_GROUPS, MAX_PRIMITIVES,
} from './territoryConfig'
import { OUTER_REACH, INNER_RING, OUTER_A, INNER_EXTRA, buildPrimitives, type BuiltPrimitives } from './territoryGeometry'
import { POCKET_FILL, type PocketMask } from './territoryPocketMask'
import type { TerritoryGroup } from './territoryRenderer'

/** GLSL float literal — guarantees a decimal point so ints aren't parsed as int. */
function glf(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n)
}

const VERT_SRC = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

#define MAX_GROUPS ${MAX_GROUPS}
#define MAX_PRIMITIVES ${MAX_PRIMITIVES}

const float REACH        = ${glf(REACH)};
const float OUTER_REACH  = ${glf(OUTER_REACH)};
const float INNER_RING   = ${glf(INNER_RING)};
const float CORNER       = ${glf(CORNER)};
const float PANEL_CORNER = ${glf(PANEL_CORNER)};
const float SMINK        = ${glf(SMINK)};
const float INTENSITY    = ${glf(INTENSITY)};
const float OUTER_A      = ${glf(OUTER_A)};
const float INNER_EXTRA  = ${glf(INNER_EXTRA)};
const float OUTLINE_WIDTH = ${glf(OUTLINE_WIDTH)};
const float OUTLINE_ALPHA = ${glf(OUTLINE_ALPHA)};
const float WARP_AMP     = ${glf(WARP_AMP)};
const float WARP_FREQ    = ${glf(WARP_FREQ)};
const float INVK         = ${glf(1 / COLOR_BLEND)};
const float CUTOFF       = ${glf(4 * COLOR_BLEND)};
const float POCKET_FILL  = ${glf(POCKET_FILL)};
const vec3  LINE         = vec3(206.0, 217.0, 236.0) / 255.0;

uniform vec2  uViewport;   // device px
uniform float uDpr;
uniform float uZoom;
uniform vec2  uOffset;     // CSS px (viewport offset)
uniform vec2  uOrigin;     // world; all primitive coords are relative to this
uniform int   uPrimCount;
uniform int   uGroupCount;
uniform sampler2D uPrims;  // RGBA32F, 2 texels per primitive
uniform vec3  uColors[MAX_GROUPS];
uniform float uDims[MAX_GROUPS];   // focus-lens opacity mult per group (1 or 0.5)
uniform sampler2D uPocketMask;
uniform int   uHasMask;
uniform vec2  uMaskOrigin; // world
uniform vec2  uMaskSize;   // world span

out vec4 fragColor;

// --- value noise (organic domain warp) — structurally identical to the CPU ---
uint uhash(int xi, int yi){
  uint h = uint(xi) * 374761393u + uint(yi) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return h;
}
float hash(float x, float y){
  return float(uhash(int(floor(x)), int(floor(y)))) / 4294967295.0;
}
float vnoise(float x, float y){
  float xi = floor(x), yi = floor(y), xf = x - xi, yf = y - yi;
  float u = xf * xf * (3.0 - 2.0 * xf);
  float v = yf * yf * (3.0 - 2.0 * yf);
  float a = hash(xi, yi), b = hash(xi + 1.0, yi);
  float c = hash(xi, yi + 1.0), d = hash(xi + 1.0, yi + 1.0);
  return a * (1.0 - u) * (1.0 - v) + b * u * (1.0 - v) + c * (1.0 - u) * v + d * u * v;
}
float fbm(float x, float y){
  return 0.5 * vnoise(x, y) + 0.25 * vnoise(x * 2.0, y * 2.0);
}

// --- signed distance fields --------------------------------------------------
float sdRoundRect(vec2 p, vec2 xy, vec2 wh, float r){
  vec2 c = xy + wh * 0.5;
  vec2 q = abs(p - c) - (wh * 0.5 - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float smin(float a, float b, float k){
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
float sdSegment(vec2 p, vec2 a, vec2 b, float r){
  vec2 pa = p - a, ba = b - a;
  float d = dot(ba, ba);
  float h = d > 1e-6 ? clamp(dot(pa, ba) / d, 0.0, 1.0) : 0.0;
  return length(pa - ba * h) - r;
}

vec4 over(vec4 dst, vec4 src){
  float a = src.a + dst.a * (1.0 - src.a);
  vec3 c = a > 0.0 ? (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / a : vec3(0.0);
  return vec4(c, a);
}

void main(){
  // Device px → CSS px (flip y to canvas top-origin) → world.
  vec2 css = vec2(gl_FragCoord.x, uViewport.y - gl_FragCoord.y) / uDpr;
  vec2 wAbs = (css - uOffset) / uZoom;
  vec2 wRel = wAbs - uOrigin;

  // Domain warp — noise sampled on ABSOLUTE world coords (matches the CPU path);
  // the warped point is kept origin-relative for SDF precision.
  float nx = fbm(wAbs.x * WARP_FREQ,        wAbs.y * WARP_FREQ);
  float ny = fbm(wAbs.x * WARP_FREQ + 31.4, wAbs.y * WARP_FREQ);
  vec2 p = wRel + (vec2(nx, ny) - 0.5) * 2.0 * WARP_AMP;

  float dg[MAX_GROUPS];
  for (int g = 0; g < MAX_GROUPS; g++) dg[g] = 1e9;
  float inside = 0.0; // panel punch-out coverage (unwarped)

  for (int i = 0; i < MAX_PRIMITIVES; i++){
    if (i >= uPrimCount) break;
    vec4 t0 = texelFetch(uPrims, ivec2(2 * i, 0), 0);
    vec4 t1 = texelFetch(uPrims, ivec2(2 * i + 1, 0), 0);
    int gi = int(t1.y + 0.5);
    int flag = int(t1.z + 0.5);
    if (flag == 0){
      vec2 xy = t0.xy;
      vec2 wh = t0.zw - t0.xy;
      dg[gi] = smin(dg[gi], sdRoundRect(p, xy, wh, t1.x), SMINK);
      float dp = sdRoundRect(wRel, xy, wh, PANEL_CORNER);
      float pe = max(fwidth(dp), 1e-4);
      inside = max(inside, 1.0 - smoothstep(-pe, pe, dp));
    } else {
      dg[gi] = smin(dg[gi], sdSegment(p, t0.xy, t0.zw, t1.x), SMINK);
    }
  }

  float mn = 1e9, mn2 = 1e9;
  int arg = 0;
  for (int g = 0; g < MAX_GROUPS; g++){
    if (g >= uGroupCount) break;
    float d = dg[g];
    if (d < mn){ mn2 = mn; mn = d; arg = g; }
    else if (d < mn2){ mn2 = d; }
  }

  vec3 col;
  float dim;
  if (mn2 - mn > CUTOFF){
    col = uColors[arg];
    dim = uDims[arg];
  } else {
    float ws = 0.0;
    vec3 acc = vec3(0.0);
    float accDim = 0.0;
    for (int g = 0; g < MAX_GROUPS; g++){
      if (g >= uGroupCount) break;
      float wgt = exp(-(dg[g] - mn) * INVK);
      ws += wgt;
      acc += wgt * uColors[g];
      accDim += wgt * uDims[g];
    }
    col = acc / ws;
    dim = accDim / ws;
  }
  // Focus lens: a dimmed worktree's territory drops to dim·opacity and is
  // desaturated toward grey (matching the panels' opacity·0.5 + saturate(0.4)).
  float t = clamp((dim - 0.5) * 2.0, 0.0, 1.0); // 1 = focused/full, 0 = dimmed
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, mix(0.4, 1.0, t));

  float combined = mn;
  // Enclosed-pocket lift (world-anchored mask) — same as CPU fillEnclosed. Lift
  // ONLY genuine background (combined >= OUTER_REACH): this keeps the fill from
  // bleeding into real territory and pins its edge to the smooth per-pixel
  // contour rather than the coarse mask boundary. textureLod (no derivatives)
  // keeps the sample valid in any control flow.
  float maskV = 0.0;
  if (uHasMask == 1){
    vec2 muv = (wAbs - uMaskOrigin) / uMaskSize;
    maskV = textureLod(uPocketMask, muv, 0.0).r;
  }
  combined = mix(combined, POCKET_FILL, step(OUTER_REACH, combined) * step(0.5, maskV));

  // Two analytic terrace shelves (crisp, fwidth-AA) — same iso-lines and the same
  // stacked alphas (OUTER_A then INNER_EXTRA → INTENSITY where they overlap).
  float aa = clamp(fwidth(combined), 1e-4, 6.0);
  float covOuter = 1.0 - smoothstep(OUTER_REACH - aa, OUTER_REACH + aa, combined);
  float covInner = 1.0 - smoothstep(INNER_RING - aa, INNER_RING + aa, combined);

  vec4 outF = vec4(0.0);
  outF = over(outF, vec4(col, OUTER_A * covOuter));
  outF = over(outF, vec4(col, INNER_EXTRA * covInner));

  // Two contour outlines (inner full, outer half).
  float innerLine = 1.0 - smoothstep(0.0, OUTLINE_WIDTH * aa, abs(combined - INNER_RING));
  float outerLine = 1.0 - smoothstep(0.0, OUTLINE_WIDTH * aa, abs(combined - OUTER_REACH));
  outF = over(outF, vec4(LINE, OUTLINE_ALPHA * innerLine));
  outF = over(outF, vec4(LINE, OUTLINE_ALPHA * 0.5 * outerLine));

  // Focus-lens opacity, then punch the panels out (halo behind them).
  outF.a *= dim;
  outF.a *= (1.0 - inside);

  fragColor = vec4(outF.rgb * outF.a, outF.a); // premultiplied
}
`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[territoryGL] shader compile failed:', gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

export interface TerritoryGL {
  resize(deviceW: number, deviceH: number): void
  setView(zoom: number, offX: number, offY: number, dpr: number): void
  uploadGeometry(built: BuiltPrimitives): void
  uploadMask(mask: PocketMask | null): void
  draw(): void
  dispose(): void
}

/** Build groups → packed primitives. Re-exported so the layer can build once and
 *  pass to uploadGeometry. */
export { buildPrimitives }

/** Create the WebGL2 territory renderer, or null if WebGL2/shaders are
 *  unavailable (the layer then falls back to the CPU `drawTerritory`). */
export function createTerritoryGL(canvas: HTMLCanvasElement): TerritoryGL | null {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  })
  if (!gl) return null

  // WebGL2 guarantees highp in the vertex shader but NOT the fragment shader.
  // The field math (world coords, warp, SDFs) genuinely needs fragment highp —
  // mediump banding would corrupt the geometry — so a GPU without it must take
  // the CPU path rather than render garbage. (precision === 0 means absent.)
  const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)
  if (!hp || hp.precision === 0) {
    console.warn('[territoryGL] no fragment highp float; falling back to CPU')
    return null
  }

  const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
  if (!vs || !fs) return null
  const program = gl.createProgram()!
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'aPos')
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[territoryGL] program link failed:', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }

  // Full-screen triangle (covers clip space).
  const vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)
  const vbo = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)

  const u = (name: string) => gl.getUniformLocation(program, name)
  const loc = {
    viewport: u('uViewport'), dpr: u('uDpr'), zoom: u('uZoom'), offset: u('uOffset'),
    origin: u('uOrigin'), primCount: u('uPrimCount'), groupCount: u('uGroupCount'),
    prims: u('uPrims'), colors: u('uColors'), dims: u('uDims'), pocketMask: u('uPocketMask'),
    hasMask: u('uHasMask'), maskOrigin: u('uMaskOrigin'), maskSize: u('uMaskSize'),
  }

  // Immutable RGBA32F data texture for primitive geometry (unit 0).
  const primTex = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, primTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, MAX_PRIMITIVES * 2, 1)

  // Mutable R8 mask texture (unit 1) — re-uploaded with texImage2D (size varies).
  const maskTex = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, maskTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]))

  // One-time GL state.
  gl.useProgram(program)
  gl.uniform1i(loc.prims, 0)
  gl.uniform1i(loc.pocketMask, 1)
  gl.uniform1i(loc.hasMask, 0)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.disable(gl.DEPTH_TEST)
  gl.enable(gl.BLEND)
  gl.blendEquation(gl.FUNC_ADD)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0)

  let deviceW = 1, deviceH = 1
  let disposed = false

  return {
    resize(dw, dh) {
      deviceW = Math.max(1, dw)
      deviceH = Math.max(1, dh)
      gl.viewport(0, 0, deviceW, deviceH)
      gl.useProgram(program)
      gl.uniform2f(loc.viewport, deviceW, deviceH)
    },
    setView(zoom, offX, offY, dpr) {
      gl.useProgram(program)
      gl.uniform1f(loc.zoom, zoom)
      gl.uniform2f(loc.offset, offX, offY)
      gl.uniform1f(loc.dpr, dpr)
    },
    uploadGeometry(built) {
      gl.useProgram(program)
      gl.uniform1i(loc.primCount, built.count)
      gl.uniform1i(loc.groupCount, built.groupCount)
      gl.uniform2f(loc.origin, built.originX, built.originY)
      if (built.groupCount > 0) {
        gl.uniform3fv(loc.colors, built.colors.subarray(0, built.groupCount * 3))
        gl.uniform1fv(loc.dims, built.dims.subarray(0, built.groupCount))
      }
      if (built.count > 0) {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, primTex)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, built.count * 2, 1, gl.RGBA, gl.FLOAT, built.data.subarray(0, built.count * 8))
      }
    },
    uploadMask(mask) {
      gl.useProgram(program)
      if (!mask) { gl.uniform1i(loc.hasMask, 0); return }
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, maskTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.w, mask.h, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data)
      gl.uniform1i(loc.hasMask, 1)
      gl.uniform2f(loc.maskOrigin, mask.originX, mask.originY)
      gl.uniform2f(loc.maskSize, mask.worldW, mask.worldH)
    },
    draw() {
      gl.useProgram(program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, primTex)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, maskTex)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.bindVertexArray(vao)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindVertexArray(null)
    },
    dispose() {
      if (disposed) return
      disposed = true
      gl.deleteTexture(primTex)
      gl.deleteTexture(maskTex)
      gl.deleteBuffer(vbo)
      gl.deleteVertexArray(vao)
      gl.deleteProgram(program)
    },
  }
}
