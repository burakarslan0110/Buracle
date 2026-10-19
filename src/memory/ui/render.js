import { STRIDE } from './brain.js'
import { hash32 } from './dom.js'

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in vec4 aMeta;
layout(location=3) in vec2 aMeta2;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uScale;
uniform float uDpr;
uniform vec3 uView;
uniform float uTime;
uniform float uMotion;
uniform float uDensity[8];
uniform float uBright[8];
uniform float uGlow[8];
uniform float uEmph[8];
uniform vec4 uRipple;
uniform float uRippleRegion;
uniform float uLight;
uniform float uPass;
out vec4 vColor;
out float vAngle;
out float vShape;
vec3 themed(vec3 c) {
  if (uLight < 0.5) return c;
  float lum = dot(c, vec3(0.3, 0.59, 0.11));
  vec3 ink = mix(c, c * c, 0.25);
  return ink * (1.0 - 0.5 * smoothstep(0.72, 1.0, lum));
}
void main() {
  int r = int(aMeta.y + 0.5);
  if (aMeta.z > uDensity[r]) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; return; }
  float ph = aMeta2.y * 6.2831853;
  vec3 p = aPos;
  p.xy += uMotion * 0.0032 * vec2(sin(uTime * 0.71 + ph), cos(uTime * 0.53 + ph * 1.3));
  float cy = cos(uView.x), sy = sin(uView.x), cx = cos(uView.y), sx = sin(uView.y);
  float x1 = p.x * cy + p.z * sy;
  float z1 = -p.x * sy + p.z * cy;
  float y2 = p.y * cx - z1 * sx;
  float z2 = p.y * sx + z1 * cx;
  float persp = 1.0 / (1.0 - z2 * 0.22);
  vec2 s = uCenter + vec2(x1, -y2) * uScale * persp * uView.z;
  gl_Position = vec4(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0, 0.0, 1.0);
  float depth = clamp(0.55 + z2 * 0.95, 0.3, 1.05);
  float tw = 1.0 - uMotion * 0.16 * (0.5 + 0.5 * sin(uTime * 1.6 + ph * 3.0));
  float rip = 0.0;
  if (uRipple.w > 0.0) {
    float d = distance(aPos.xy, uRipple.xy);
    float k = (d - uRipple.z * 0.85) / 0.07;
    rip = uRipple.w * exp(-k * k) * (abs(float(r) - uRippleRegion) < 0.5 ? 1.0 : 0.3);
  }
  float g = uGlow[r];
  float b = aMeta.w * uBright[r] * depth * tw * uEmph[r] + g * 0.85 * aMeta.w + rip;
  vec3 c = themed(aColor);
  vec3 hi = uLight < 0.5 ? vec3(1.0) : c * 0.45;
  vColor = vec4(mix(c, hi, clamp(g * 0.3 + rip * 0.45, 0.0, 0.6)), b);
  vAngle = aMeta.x;
  vShape = (uPass > 0.5 || aMeta2.x < 0.0) ? 1.0 : 0.0;
  gl_PointSize = abs(aMeta2.x) * clamp(uScale / 340.0, 0.7, 2.0) * uDpr * persp * (1.0 + g * 0.3) * (uLight < 0.5 ? 1.0 : (uPass > 0.5 ? 3.6 : 1.3));
}`

const FS = `#version 300 es
precision mediump float;
in vec4 vColor;
in float vAngle;
in float vShape;
uniform float uAlpha;
uniform highp float uLight;
out vec4 o;
void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float a;
  if (vShape > 0.5) {
    a = 1.0 - smoothstep(0.15, 1.0, length(pc));
  } else {
    float c = cos(vAngle), s = sin(vAngle);
    vec2 q = vec2(c * pc.x + s * pc.y, -s * pc.x + c * pc.y);
    float d = length(vec2(max(abs(q.x) - 0.6, 0.0), q.y));
    a = uLight < 0.5 ? 1.0 - smoothstep(0.1, 0.3, d) : 1.0 - smoothstep(0.05, 0.5, d);
  }
  float al = a * vColor.a * uAlpha;
  if (al < 0.003) discard;
  if (uLight > 0.5) { o = vec4(mix(vec3(1.0), vColor.rgb, min(al, 1.0)), 1.0); return; }
  o = vec4(vColor.rgb * al, al);
}`

const NODE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in vec2 aState;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uScale;
uniform float uDpr;
uniform vec3 uView;
uniform float uTime;
uniform float uMotion;
uniform float uLight;
out vec4 vColor;
vec3 deep(vec3 c) {
  if (uLight < 0.5) return c;
  float lum = dot(c, vec3(0.3, 0.59, 0.11));
  return c * c * 0.9 * (1.0 - 0.55 * smoothstep(0.72, 1.0, lum));
}
void main() {
  vec3 p = aPos;
  float cy = cos(uView.x), sy = sin(uView.x), cx = cos(uView.y), sx = sin(uView.y);
  float x1 = p.x * cy + p.z * sy;
  float z1 = -p.x * sy + p.z * cy;
  float y2 = p.y * cx - z1 * sx;
  float z2 = p.y * sx + z1 * cx;
  float persp = 1.0 / (1.0 - z2 * 0.22);
  vec2 s = uCenter + vec2(x1, -y2) * uScale * persp * uView.z;
  gl_Position = vec4(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0, 0.0, 1.0);
  float lv = aState.x;
  float tw = 0.78 + 0.22 * sin(uTime * (1.1 + aState.y) + aState.y * 40.0) * uMotion;
  vColor = vec4(deep(aColor), clamp(lv * tw, 0.0, 2.0));
  gl_PointSize = (5.0 + 7.0 * min(lv, 1.6)) * clamp(uScale / 340.0, 0.8, 1.6) * uDpr * persp;
}`

const NODE_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
uniform highp float uLight;
out vec4 o;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  float core = 1.0 - smoothstep(0.0, 0.3, d);
  float halo = exp(-d * d * 5.0) * 0.55;
  float a = (core + halo) * vColor.a;
  if (a < 0.003) discard;
  if (uLight > 0.5) { o = vec4(mix(vec3(1.0), vColor.rgb, min(a * 0.9, 1.0)), 1.0); return; }
  o = vec4(vColor.rgb * a, a * 0.9);
}`

export function project(view, x, y, z) {
  const cy = Math.cos(view.rotY), sy = Math.sin(view.rotY), cx = Math.cos(view.rotX), sx = Math.sin(view.rotX)
  const x1 = x * cy + z * sy
  const z1 = -x * sy + z * cy
  const y2 = y * cx - z1 * sx
  const z2 = y * sx + z1 * cx
  const persp = 1 / (1 - z2 * 0.22)
  return [view.cx + x1 * view.scale * persp * view.breath, view.cy - y2 * view.scale * persp * view.breath, z2]
}

function compile(gl, type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader')
  return s
}

function program(gl, vs, fs) {
  const p = gl.createProgram()
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link')
  return p
}

const lerp = (a, b, s) => a + (b - a) * s
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

function themedRgb(c) {
  const lum = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11
  const k = 1 - 0.5 * smoothstep(0.72, 1, lum)
  return c.map(v => (v * 0.75 + v * v * 0.25) * k)
}

function deepRgb(c) {
  const lum = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11
  const k = 0.9 * (1 - 0.55 * smoothstep(0.72, 1, lum))
  return c.map(v => v * v * k)
}

export function createRenderer(canvas, brain, opts = {}) {
  const reduced = opts.reducedMotion === true
  const view = { cx: 0, cy: 0, scale: 300, rotY: 0, rotX: 0, breath: 1, time: 0, width: 1, height: 1, dpr: 1 }
  const target = { cx: 0, cy: 0, scale: 300 }
  const drag = { y: 0, x: 0, vy: 0, vx: 0, active: false }
  const regions = {
    density: new Float32Array(8).fill(0.3),
    bright: new Float32Array(8).fill(0.35),
    glow: new Float32Array(8),
    emph: new Float32Array(8).fill(1),
    tDensity: new Float32Array(8).fill(0.3),
    tBright: new Float32Array(8).fill(0.35),
    tEmph: new Float32Array(8).fill(1),
    fade: new Float32Array(8),
  }
  const ripple = { x: 0, y: 0, age: 9, strength: 0, region: -1 }
  let nodes = []
  let nodeItems = []
  let nodeLevel = new Float32Array(0)
  let nodeTarget = new Float32Array(0)
  let raf = 0
  let running = false
  let dirty = true
  let last = 0
  let light = false

  let gl = null
  if (shadersCompile()) {
    try {
      gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' })
    } catch { gl = null }
  }
  let impl
  try {
    impl = gl ? webgl(gl) : null
  } catch (e) {
    console.warn('brain: WebGL2 failed, drawing in 2D', e)
    impl = null
  }
  if (impl === null) impl = canvas2d(canvas.getContext('2d'))

  function shadersCompile() {
    try {
      const probe = document.createElement('canvas').getContext('webgl2')
      if (probe === null) return false
      program(probe, VS, FS)
      program(probe, NODE_VS, NODE_FS)
      return true
    } catch (e) {
      console.warn('brain: WebGL2 is not usable here, drawing in 2D', e)
      return false
    }
  }

  function webgl(gl) {
    const prog = program(gl, VS, FS)
    const nprog = program(gl, NODE_VS, NODE_FS)
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    const upload = () => gl.bufferData(gl.ARRAY_BUFFER, brain.data.subarray(0, brain.count * STRIDE), gl.STATIC_DRAW)
    upload()
    const B = 4 * STRIDE
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, B, 0)
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, B, 12)
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, B, 24)
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, B, 40)
    gl.bindVertexArray(null)
    const nvao = gl.createVertexArray()
    const nbuf = gl.createBuffer()
    const sbuf = gl.createBuffer()
    let nodeCount = 0
    const U = n => gl.getUniformLocation(prog, n)
    const u = { res: U('uRes'), center: U('uCenter'), scale: U('uScale'), dpr: U('uDpr'), view: U('uView'), time: U('uTime'), motion: U('uMotion'), light: U('uLight'), pass: U('uPass'), density: U('uDensity'), bright: U('uBright'), glow: U('uGlow'), emph: U('uEmph'), ripple: U('uRipple'), rippleRegion: U('uRippleRegion'), alpha: U('uAlpha') }
    const N = n => gl.getUniformLocation(nprog, n)
    const nu = { res: N('uRes'), center: N('uCenter'), scale: N('uScale'), dpr: N('uDpr'), view: N('uView'), time: N('uTime'), motion: N('uMotion'), light: N('uLight') }
    const state = new Float32Array(0)
    let nodeState = state
    return {
      kind: 'webgl2',
      setBrain() {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        upload()
      },
      setNodes(list) {
        nodeCount = list.length
        const pos = new Float32Array(nodeCount * 6)
        nodeState = new Float32Array(nodeCount * 2)
        list.forEach((nd, i) => {
          pos.set([nd.x, nd.y, nd.z, nd.r, nd.g, nd.b], i * 6)
          nodeState[i * 2 + 1] = nd.phase
        })
        gl.bindVertexArray(nvao)
        gl.bindBuffer(gl.ARRAY_BUFFER, nbuf)
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW)
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0)
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12)
        gl.bindBuffer(gl.ARRAY_BUFFER, sbuf)
        gl.bufferData(gl.ARRAY_BUFFER, nodeState, gl.DYNAMIC_DRAW)
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 8, 0)
        gl.bindVertexArray(null)
      },
      draw() {
        gl.viewport(0, 0, canvas.width, canvas.height)
        if (light) gl.clearColor(1, 1, 1, 1)
        else gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.enable(gl.BLEND)
        if (light) gl.blendFunc(gl.DST_COLOR, gl.ZERO)
        else gl.blendFunc(gl.ONE, gl.ONE)
        const common = (k) => {
          gl.uniform2f(k.res, view.width, view.height)
          gl.uniform2f(k.center, view.cx, view.cy)
          gl.uniform1f(k.scale, view.scale)
          gl.uniform1f(k.dpr, view.dpr)
          gl.uniform3f(k.view, view.rotY, view.rotX, view.breath)
          gl.uniform1f(k.time, view.time)
          gl.uniform1f(k.motion, reduced ? 0 : 1)
          gl.uniform1f(k.light, light ? 1 : 0)
        }
        gl.useProgram(prog)
        common(u)
        gl.uniform1fv(u.density, regions.density)
        const bright = new Float32Array(8)
        for (let i = 0; i < 8; i++) bright[i] = regions.bright[i] * (1 - 0.65 * regions.fade[i])
        gl.uniform1fv(u.bright, bright)
        gl.uniform1fv(u.glow, regions.glow)
        gl.uniform1fv(u.emph, regions.emph)
        gl.uniform4f(u.ripple, ripple.x, ripple.y, ripple.age, ripple.strength)
        gl.uniform1f(u.rippleRegion, ripple.region)
        const baseAlpha = view.width < 700 ? 0.62 : 0.5
        gl.bindVertexArray(vao)
        if (light) {
          gl.uniform1f(u.pass, 1)
          gl.uniform1f(u.alpha, baseAlpha * 0.12)
          gl.drawArrays(gl.POINTS, 0, brain.count)
        }
        gl.uniform1f(u.pass, 0)
        gl.uniform1f(u.alpha, light ? baseAlpha * 0.55 : baseAlpha)
        gl.drawArrays(gl.POINTS, 0, brain.count)
        if (nodeCount > 0) {
          for (let i = 0; i < nodeCount; i++) nodeState[i * 2] = nodeLevel[i]
          gl.bindBuffer(gl.ARRAY_BUFFER, sbuf)
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, nodeState)
          gl.useProgram(nprog)
          common(nu)
          gl.bindVertexArray(nvao)
          gl.drawArrays(gl.POINTS, 0, nodeCount)
        }
        gl.bindVertexArray(null)
      },
    }
  }

  function canvas2d(ctx) {
    let list = []
    const bucket = () => {
      const keep = Math.min(brain.count, 9000)
      const step = brain.count / keep
      const buckets = new Map()
      for (let k = 0; k < keep; k++) {
        const i = Math.floor(k * step)
        const o = i * STRIDE
        const reg = brain.data[o + 7]
        const q = (c) => Math.round(brain.data[o + c] * 3)
        const lit = Math.min(3, Math.round(brain.data[o + 9] * 2))
        const key = `${reg}:${q(3)}${q(4)}${q(5)}:${lit}`
        let bk = buckets.get(key)
        if (bk === undefined) {
          bk = { reg, rgb: [q(3) / 3, q(4) / 3, q(5) / 3], lit: Math.max(0.25, lit / 2), items: [] }
          buckets.set(key, bk)
        }
        bk.items.push(i)
      }
      list = [...buckets.values()]
    }
    bucket()
    return {
      kind: '2d',
      setBrain: bucket,
      setNodes() {},
      draw() {
        const d = view.dpr
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        if (light) {
          ctx.globalCompositeOperation = 'source-over'
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
        ctx.globalCompositeOperation = light ? 'multiply' : 'lighter'
        ctx.lineCap = 'round'
        const level = (r) => Math.min(1, regions.bright[r] * regions.emph[r] * (1 - 0.65 * regions.fade[r]) * 0.55 + regions.glow[r] * 0.5)
        if (light) {
          const R = 4.5 * d * Math.min(2, Math.max(0.7, view.scale / 340))
          for (const bk of list) {
            const r = bk.reg
            const a = bk.lit * level(r) * 0.12
            if (a < 0.01) continue
            const rgb = themedRgb(bk.rgb)
            ctx.fillStyle = `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a.toFixed(3)})`
            ctx.beginPath()
            for (const i of bk.items) {
              const o = i * STRIDE
              if (brain.data[o + 8] > regions.density[r]) continue
              const [sx, sy] = project(view, brain.data[o], brain.data[o + 1], brain.data[o + 2])
              ctx.moveTo(sx * d + R, sy * d)
              ctx.arc(sx * d, sy * d, R, 0, Math.PI * 2)
            }
            ctx.fill()
          }
        }
        ctx.lineWidth = (light ? 1.4 : 1.1) * d
        for (const bk of list) {
          const r = bk.reg
          const a = bk.lit * level(r) * (light ? 0.55 : 1)
          if (a < 0.02) continue
          const rgb = light ? themedRgb(bk.rgb) : bk.rgb
          ctx.strokeStyle = `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a.toFixed(3)})`
          ctx.beginPath()
          for (const i of bk.items) {
            const o = i * STRIDE
            if (brain.data[o + 8] > regions.density[r]) continue
            const [sx, sy] = project(view, brain.data[o], brain.data[o + 1], brain.data[o + 2])
            const len = Math.abs(brain.data[o + 10]) * 0.45 * d * Math.min(2, Math.max(0.7, view.scale / 340))
            const ang = brain.data[o + 6]
            const dx = Math.cos(ang) * len
            const dy = Math.sin(ang) * len
            ctx.moveTo(sx * d - dx, sy * d - dy)
            ctx.lineTo(sx * d + dx, sy * d + dy)
          }
          ctx.stroke()
        }
        for (let i = 0; i < nodes.length; i++) {
          const nd = nodes[i]
          const lv = nodeLevel[i]
          if (lv < 0.05) continue
          const [sx, sy] = project(view, nd.x, nd.y, nd.z)
          const rgb = light ? deepRgb([nd.r, nd.g, nd.b]) : [nd.r, nd.g, nd.b]
          ctx.fillStyle = `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${Math.min(1, lv * 0.8).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(sx * d, sy * d, (1.6 + 2.4 * Math.min(lv, 1.6)) * d, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.globalCompositeOperation = 'source-over'
      },
    }
  }

  function step(dt) {
    const ease = reduced ? 1 : 1 - Math.exp(-dt * 4)
    let changing = false
    for (let i = 0; i < 8; i++) {
      const before = regions.density[i] + regions.bright[i] + regions.emph[i] + regions.glow[i] + regions.fade[i]
      regions.density[i] = lerp(regions.density[i], regions.tDensity[i], ease)
      regions.bright[i] = lerp(regions.bright[i], regions.tBright[i], ease)
      regions.emph[i] = lerp(regions.emph[i], regions.tEmph[i], reduced ? 1 : 1 - Math.exp(-dt * 7))
      regions.glow[i] = Math.max(0, regions.glow[i] - dt * (reduced ? 2 : 0.55))
      regions.fade[i] = Math.max(0, regions.fade[i] - dt * (reduced ? 2 : 0.4))
      const after = regions.density[i] + regions.bright[i] + regions.emph[i] + regions.glow[i] + regions.fade[i]
      if (Math.abs(after - before) > 1e-4) changing = true
    }
    for (let i = 0; i < nodeLevel.length; i++) {
      const v = lerp(nodeLevel[i], nodeTarget[i], reduced ? 1 : 1 - Math.exp(-dt * 6))
      if (Math.abs(v - nodeLevel[i]) > 1e-4) changing = true
      nodeLevel[i] = v
    }
    if (ripple.strength > 0) {
      ripple.age += dt
      ripple.strength = Math.max(0, ripple.strength - dt * 0.6)
      changing = true
    }
    const lay = reduced ? 1 : 1 - Math.exp(-dt * 6)
    view.cx = lerp(view.cx, target.cx, lay)
    view.cy = lerp(view.cy, target.cy, lay)
    view.scale = lerp(view.scale, target.scale, lay)
    if (Math.abs(view.cx - target.cx) + Math.abs(view.cy - target.cy) + Math.abs(view.scale - target.scale) > 0.05) changing = true
    if (!drag.active) {
      const back = 1 - Math.exp(-dt * 0.8)
      drag.y = lerp(drag.y, 0, back)
      drag.x = lerp(drag.x, 0, back)
      if (Math.abs(drag.y) + Math.abs(drag.x) > 1e-3) changing = true
    }
    if (!reduced) view.time += dt
    const idle = reduced ? 0 : 1
    view.rotY = drag.y + idle * 0.16 * Math.sin(view.time * 0.11)
    view.rotX = drag.x + idle * 0.05 * Math.sin(view.time * 0.083)
    view.breath = 1 + idle * 0.006 * Math.sin(view.time * 0.8)
    return changing
  }

  function frame(now) {
    raf = 0
    if (!running) return
    const dt = last === 0 ? 0.016 : Math.min(0.1, (now - last) / 1000)
    last = now
    const changing = step(dt)
    if (!reduced || changing || dirty) {
      dirty = false
      impl.draw()
      opts.onFrame?.(view)
    }
    if (!reduced || changing) raf = requestAnimationFrame(frame)
  }

  function wake() {
    dirty = true
    if (running && raf === 0) {
      last = 0
      raf = requestAnimationFrame(frame)
    }
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = canvas.clientWidth
    const hgt = canvas.clientHeight
    view.width = w
    view.height = hgt
    view.dpr = dpr
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(hgt * dpr))
    wake()
  }

  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); running = false })
  canvas.addEventListener('webglcontextrestored', () => location.reload())

  function placeNodes(items) {
    const before = new Map()
    nodes.forEach((nd, i) => before.set(nd.id, [nodeLevel[i], nodeTarget[i]]))
    nodes = items.map(it => {
      const ri = it.regionIndex
      const pool = brain.byRegion[ri] ?? []
      const hsh = hash32(it.id)
      const idx = pool.length > 0 ? pool[hsh % pool.length] : -1
      const o = idx * STRIDE
      const base = brain.rgb[ri] ?? [1, 1, 1]
      const nd = idx >= 0
        ? { id: it.id, region: ri, x: brain.data[o], y: brain.data[o + 1], z: brain.data[o + 2] + 0.01 }
        : { id: it.id, region: ri, x: (brain.anchors[ri] ?? [0, 0, 0])[0], y: (brain.anchors[ri] ?? [0, 0, 0])[1], z: 0.3 }
      return { ...nd, r: Math.min(1, base[0] * 0.6 + 0.4), g: Math.min(1, base[1] * 0.6 + 0.4), b: Math.min(1, base[2] * 0.6 + 0.4), phase: (hsh % 1000) / 1000, base: it.base ?? 0.5 }
    })
    nodeLevel = new Float32Array(nodes.length)
    nodeTarget = new Float32Array(nodes.length)
    nodes.forEach((nd, i) => {
      const had = before.get(nd.id)
      nodeLevel[i] = had !== undefined ? had[0] : 0
      nodeTarget[i] = had !== undefined ? had[1] : nd.base
    })
    impl.setNodes(nodes)
    wake()
  }

  return {
    get kind() { return impl.kind },
    view,
    resize,
    setBrain(b) {
      if (b === brain) return
      brain = b
      impl.setBrain()
      if (nodeItems.length > 0) placeNodes(nodeItems)
      wake()
    },
    setTheme(name) {
      light = name === 'light'
      wake()
    },
    layout(cx, cy, scale, now = false) {
      target.cx = cx
      target.cy = cy
      target.scale = scale
      if (now) { view.cx = cx; view.cy = cy; view.scale = scale }
      wake()
    },
    setRegions(levels) {
      levels.forEach((lv, i) => {
        regions.tDensity[i] = lv.density
        regions.tBright[i] = lv.bright
      })
      wake()
    },
    setEmphasis(emph) {
      for (let i = 0; i < 8; i++) regions.tEmph[i] = emph ? emph[i] ?? 1 : 1
      wake()
    },
    pulse(region, kind) {
      const all = region < 0
      for (let i = 0; i < 8; i++) {
        if (!all && i !== region) continue
        if (kind === 'fade') regions.fade[i] = 1
        else regions.glow[i] = Math.max(regions.glow[i], kind === 'write' ? (all ? 0.35 : 1) : (all ? 0.2 : 0.5))
      }
      if (!all && kind === 'write') {
        const a = brain.anchors[region] ?? [0, 0, 0]
        ripple.x = a[0]
        ripple.y = a[1]
        ripple.age = 0
        ripple.strength = 0.9
        ripple.region = region
      }
      wake()
    },
    setNodes(items) {
      nodeItems = items
      placeNodes(items)
    },
    setNodeLevels(levels, rest = 0.5) {
      for (let i = 0; i < nodes.length; i++) nodeTarget[i] = levels === null ? nodes[i].base : levels.get(nodes[i].id) ?? Math.min(rest, nodes[i].base)
      wake()
    },
    flashNodes(ids) {
      const set = new Set(ids)
      for (let i = 0; i < nodes.length; i++) if (set.has(nodes[i].id)) nodeLevel[i] = 2
      wake()
    },
    pickRegion(px, py) {
      const s = view.scale * view.breath
      const x = (px - view.cx) / s / Math.max(0.3, Math.cos(view.rotY))
      const y = -(py - view.cy) / s / Math.max(0.3, Math.cos(view.rotX))
      return brain.regionAt(x, y)
    },
    dragBy(dx, dy) {
      drag.y = Math.max(-0.7, Math.min(0.7, drag.y + dx * 0.006))
      drag.x = Math.max(-0.35, Math.min(0.35, drag.x + dy * 0.004))
      wake()
    },
    setDragging(on) { drag.active = on; wake() },
    start() {
      if (running) return
      running = true
      wake()
    },
    stop() {
      running = false
      if (raf !== 0) cancelAnimationFrame(raf)
      raf = 0
    },
    redraw: wake,
  }
}
