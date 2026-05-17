import { useState, useRef, useCallback, useEffect } from 'react'
import * as THREE from 'three'
import { motion } from 'framer-motion'

// ─── Presets ──────────────────────────────────────────────────────────────────
const SNAP = 72
const snapIdx = (angle: number) => ((Math.round(angle / SNAP) % 5) + 5) % 5

// Left gear — PITCH only (upper-sideband ring-mod for up, lowpass for down)
//   hOut = highpass path (pitch up)   lOut = lowpass path (pitch down)
const PITCH = [
  { dry:0, rGain:1.0, hOut:1.0, lOut:0, oscFreq:800, hpFreq:750, lpFreq:900 }, // ↑↑ Very High
  { dry:0, rGain:1.0, hOut:1.0, lOut:0, oscFreq:420, hpFreq:370, lpFreq:900 }, // ↑  High
  { dry:1, rGain:0,   hOut:0,   lOut:0, oscFreq:420, hpFreq:370, lpFreq:900 }, // ━  Normal
  { dry:0, rGain:0.9, hOut:0,   lOut:1, oscFreq:40,  hpFreq:370, lpFreq:700 }, // ↓  Low
  { dry:0, rGain:0.8, hOut:0,   lOut:1, oscFreq:20,  hpFreq:370, lpFreq:400 }, // ↓↓ Very Low
] as const

// Right gear — EFFECT type (each uses one path: bp / hp / delay)
const FX = [
  { dry:1,   rGain:0,   bOut:0,   hOut:0,    oscFreq:80,   bpFreq:800, bpQ:2, hpFreq:450, dly:0.12, fb:0,    wet:0   }, // DRY
  { dry:0,   rGain:0.9, bOut:1.0, hOut:0,    oscFreq:80,   bpFreq:800, bpQ:5, hpFreq:450, dly:0.12, fb:0,    wet:0   }, // ROBOT
  { dry:0.4, rGain:0,   bOut:0,   hOut:0,    oscFreq:80,   bpFreq:800, bpQ:2, hpFreq:450, dly:0.36, fb:0.50, wet:0.9 }, // ECHO
  { dry:0,   rGain:0.9, bOut:0,   hOut:0.95, oscFreq:1100, bpFreq:800, bpQ:2, hpFreq:1000,dly:0.12, fb:0,    wet:0   }, // ALIEN
  { dry:0.3, rGain:0.8, bOut:0,   hOut:0.85, oscFreq:520,  bpFreq:800, bpQ:2, hpFreq:480, dly:0.14, fb:0.28, wet:0.5 }, // CHAOS
] as const

const PITCH_LABELS = ['↑↑ VERY HIGH', '↑  HIGH', '━  NORMAL', '↓  LOW', '↓↓ VERY LOW']
const FX_LABELS    = ['DRY', 'ROBOT', 'ECHO', 'ALIEN', 'CHAOS']

// ─── Audio pipeline ───────────────────────────────────────────────────────────
// Serial: mic → [pitch section] → pitchMix → [fx section] → destination
// Pitch section and FX section are completely independent so they never bleed.
interface Pipeline { setPitch: (i: number) => void; setFx: (i: number) => void; stop: () => void }

function buildPipeline(actx: AudioContext, stream: MediaStream): Pipeline {
  const src = actx.createMediaStreamSource(stream)

  // ── Pitch section ───────────────────────────────────────────────────────────
  const pOsc = actx.createOscillator(); pOsc.type = 'sawtooth'; pOsc.start()
  const pRing = actx.createGain(); pRing.gain.value = 0       // osc modulates this
  const pHP   = actx.createBiquadFilter(); pHP.type = 'highpass'  // keeps upper sideband
  const pLP   = actx.createBiquadFilter(); pLP.type = 'lowpass'   // darker sound
  const pHOut = actx.createGain(); pHOut.gain.value = 0       // pitch-up output
  const pLOut = actx.createGain(); pLOut.gain.value = 0       // pitch-down output
  const pDry  = actx.createGain(); pDry.gain.value = 1        // normal passthrough
  const pMix  = actx.createGain(); pMix.gain.value = 1        // sum → fx section input

  src.connect(pDry);  pDry.connect(pMix)
  src.connect(pRing); pOsc.connect(pRing.gain)
  pRing.connect(pHP); pHP.connect(pHOut); pHOut.connect(pMix)
  pRing.connect(pLP); pLP.connect(pLOut); pLOut.connect(pMix)

  // ── FX section ──────────────────────────────────────────────────────────────
  const fOsc  = actx.createOscillator(); fOsc.type = 'sawtooth'; fOsc.start()
  const fRing = actx.createGain(); fRing.gain.value = 0
  const fBP   = actx.createBiquadFilter(); fBP.type = 'bandpass'
  const fHP   = actx.createBiquadFilter(); fHP.type = 'highpass'
  const fBOut = actx.createGain(); fBOut.gain.value = 0
  const fHOut = actx.createGain(); fHOut.gain.value = 0
  const fDly  = actx.createDelay(1.0); fDly.delayTime.value = 0.12
  const fFB   = actx.createGain(); fFB.gain.value = 0
  const fWet  = actx.createGain(); fWet.gain.value = 0
  const fDry  = actx.createGain(); fDry.gain.value = 1

  pMix.connect(fDry);  fDry.connect(actx.destination)
  pMix.connect(fRing); fOsc.connect(fRing.gain)
  fRing.connect(fBP);  fBP.connect(fBOut);  fBOut.connect(actx.destination)
  fRing.connect(fHP);  fHP.connect(fHOut);  fHOut.connect(actx.destination)
  pMix.connect(fDly);  fDly.connect(fFB); fFB.connect(fDly); fDly.connect(fWet); fWet.connect(actx.destination)

  const mute = (gains: AudioParam[], now: number) =>
    gains.forEach(g => { g.cancelScheduledValues(now); g.setValueAtTime(0, now + 0.005) })

  const ramp = (g: AudioParam, v: number, t: number) => g.linearRampToValueAtTime(v, t)

  const setPitch = (i: number) => {
    const p = PITCH[Math.max(0, Math.min(4, i))]
    const now = actx.currentTime, end = now + 0.04
    mute([pDry.gain, pHOut.gain, pLOut.gain], now)
    pOsc.frequency.setValueAtTime(p.oscFreq, now)
    pRing.gain.setValueAtTime(p.rGain, now)
    pHP.frequency.setValueAtTime(p.hpFreq, now)
    pLP.frequency.setValueAtTime(p.lpFreq, now)
    ramp(pDry.gain, p.dry, end); ramp(pHOut.gain, p.hOut, end); ramp(pLOut.gain, p.lOut, end)
  }

  const setFx = (i: number) => {
    const p = FX[Math.max(0, Math.min(4, i))]
    const now = actx.currentTime, end = now + 0.04
    mute([fDry.gain, fBOut.gain, fHOut.gain, fWet.gain, fFB.gain], now)
    fOsc.frequency.setValueAtTime(p.oscFreq, now)
    fRing.gain.setValueAtTime(p.rGain, now)
    fBP.frequency.setValueAtTime(p.bpFreq, now); fBP.Q.setValueAtTime(p.bpQ, now)
    fHP.frequency.setValueAtTime(p.hpFreq, now)
    fDly.delayTime.setValueAtTime(p.dly, now)
    ramp(fDry.gain, p.dry, end); ramp(fBOut.gain, p.bOut, end); ramp(fHOut.gain, p.hOut, end)
    ramp(fFB.gain, p.fb, end); ramp(fWet.gain, p.wet, end)
  }

  const stop = () => {
    try { pOsc.stop(); fOsc.stop() } catch {}
    try { [src,pOsc,pRing,pHP,pLP,pHOut,pLOut,pDry,pMix,
           fOsc,fRing,fBP,fHP,fBOut,fHOut,fDly,fFB,fWet,fDry].forEach(n => n.disconnect()) } catch {}
  }

  return { setPitch, setFx, stop }
}

// ─── Gear SVG helper ──────────────────────────────────────────────────────────
function makeGear(r1: number, r2: number, n: number): string {
  const step = (2 * Math.PI) / n, tw = step * 0.38
  let d = ''
  for (let i = 0; i < n; i++) {
    const a = i * step - Math.PI / 2
    const x = (r: number, ang: number) => (r * Math.cos(ang)).toFixed(2)
    const y = (r: number, ang: number) => (r * Math.sin(ang)).toFixed(2)
    d += (i === 0 ? `M ` : `L `) + `${x(r2,a)} ${y(r2,a)} `
    d += `L ${x(r1, a+(step-tw)/2)} ${y(r1, a+(step-tw)/2)} `
    d += `L ${x(r1, a+(step+tw)/2)} ${y(r1, a+(step+tw)/2)} `
  }
  return d + 'Z'
}
const GEAR = makeGear(62, 50, 18)
const GEAR_DOTS = [0,72,144,216,288].map(deg => ({
  cx: +(34*Math.cos((deg-90)*Math.PI/180)).toFixed(2),
  cy: +(34*Math.sin((deg-90)*Math.PI/180)).toFixed(2),
}))


// ─── SVG wing paths (back face) ───────────────────────────────────────────────
const LW     = 'M -26,-14 C -55,-88 -172,-108 -228,-58 C -258,-28 -255,52 -218,88 C -178,112 -85,102 -26,40 Z'
const LW_MID = 'M -26,-14 C -55,-88 -172,-108 -228,-58 C -258,-28 -254,26 -222,58 C -182,80 -88,72 -26,22 Z'
const LW_HL  = 'M -26,-14 C -55,-88 -172,-108 -228,-58 C -248,-46 -252,-14 -238,2 C -188,-6 -88,-12 -26,-10 Z'
const RW     = 'M 26,-14 C 55,-88 172,-108 228,-58 C 258,-28 255,52 218,88 C 178,112 85,102 26,40 Z'
const RW_MID = 'M 26,-14 C 55,-88 172,-108 228,-58 C 258,-28 254,26 222,58 C 182,80 88,72 26,22 Z'
const RW_HL  = 'M 26,-14 C 55,-88 172,-108 228,-58 C 248,-46 252,-14 238,2 C 188,-6 88,-12 26,-10 Z'

function Wings() {
  return (
    <>
      <path d={LW}     fill="#7A0808"/><path d={LW_MID} fill="#C01414"/><path d={LW_HL} fill="#D02020"/>
      <ellipse cx="-132" cy="-52" rx="54" ry="20" fill="rgba(255,210,210,0.18)" transform="rotate(-16,-132,-52)"/>
      <path d="M -26,10 C -95,18 -185,14 -228,2" fill="none" stroke="rgba(0,0,0,0.28)" strokeWidth="2.2" strokeLinecap="round"/>
      <path d={LW} fill="none" stroke="#180000" strokeWidth="3.5" strokeLinejoin="round"/>
      <path d={RW}     fill="#7A0808"/><path d={RW_MID} fill="#C01414"/><path d={RW_HL} fill="#D02020"/>
      <ellipse cx="132" cy="-52" rx="54" ry="20" fill="rgba(255,210,210,0.18)" transform="rotate(16,132,-52)"/>
      <path d="M 26,10 C 95,18 185,14 228,2" fill="none" stroke="rgba(0,0,0,0.28)" strokeWidth="2.2" strokeLinecap="round"/>
      <path d={RW} fill="none" stroke="#180000" strokeWidth="3.5" strokeLinejoin="round"/>
    </>
  )
}
function Tails() {
  return (
    <>
      <path d="M -22,40 C -24,68 -28,104 -26,128 C -22,133 -16,133 -12,128 C -10,104 -14,68 -16,40 Z" fill="#8B0808" stroke="#180000" strokeWidth="2.2"/>
      <path d="M 22,40 C 24,68 28,104 26,128 C 22,133 16,133 12,128 C 10,104 14,68 16,40 Z"  fill="#8B0808" stroke="#180000" strokeWidth="2.2"/>
    </>
  )
}

// ─── Back face — two independent gears ────────────────────────────────────────
interface BackProps {
  leftAngle: number;  leftSnapping: boolean;  pitchIdx: number
  rightAngle: number; rightSnapping: boolean; fxIdx: number
  onLeftDragStart: () => void;  onLeftDrag: (d: number) => void;  onLeftDragEnd: () => void
  onRightDragStart: () => void; onRightDrag: (d: number) => void; onRightDragEnd: () => void
  onTap: () => void
}

function BackFace({
  leftAngle, leftSnapping, pitchIdx,
  rightAngle, rightSnapping, fxIdx,
  onLeftDragStart, onLeftDrag, onLeftDragEnd,
  onRightDragStart, onRightDrag, onRightDragEnd,
  onTap,
}: BackProps) {
  const svgRef  = useRef<SVGSVGElement>(null)
  const lastAL  = useRef(0)
  const lastAR  = useRef(0)

  const getAngle = (e: React.PointerEvent, cx: number, cy: number) => {
    const pt = svgRef.current!.createSVGPoint()
    pt.x = e.clientX; pt.y = e.clientY
    const p = pt.matrixTransform(svgRef.current!.getScreenCTM()!.inverse())
    return Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI
  }

  const makeHandlers = (
    lastA: React.MutableRefObject<number>,
    cx: number, cy: number,
    onStart: () => void, onDrag: (d: number) => void, onEnd: () => void,
  ) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId)
      lastA.current = getAngle(e, cx, cy); onStart()
    },
    onPointerMove: (e: React.PointerEvent) => {
      const a = getAngle(e, cx, cy)
      let d = a - lastA.current
      if (d > 180) d -= 360; if (d < -180) d += 360
      lastA.current = a; onDrag(d)
    },
    onPointerUp:     (e: React.PointerEvent) => { e.stopPropagation(); onEnd() },
    onPointerLeave:  (e: React.PointerEvent) => { e.stopPropagation(); onEnd() },
    onPointerCancel: (e: React.PointerEvent) => { e.stopPropagation(); onEnd() },
    onClick:         (e: React.MouseEvent)   => e.stopPropagation(),
  })

  const GearFace = ({ angle, snapping }: { angle: number; snapping: boolean }) => (
    <motion.g
      animate={{ rotate: angle }}
      transition={snapping ? { type:'spring', stiffness:380, damping:30 } : { type:'tween', duration:0 }}
    >
      <path d={GEAR} fill="#B0B0B0"/><path d={GEAR} fill="none" stroke="#222" strokeWidth="1.5"/>
      <path d={makeGear(63,51,18)} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8"/>
      <circle r="50" fill="#C8C8C8"/>
      <path d="M -50,0 A 50,50 0 0 0 50,0 L 46,0 A 46,46 0 0 1 -46,0 Z" fill="rgba(0,0,0,0.22)"/>
      <path d="M -44,-18 A 46,46 0 0 1 44,-18" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="3" strokeLinecap="round"/>
      <circle r="42" fill="none" stroke="#AAA" strokeWidth="2"/>
      <circle r="42" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" strokeDasharray="132 132" strokeDashoffset="66"/>
      {GEAR_DOTS.map(({ cx:dx, cy:dy }, i) => (
        <g key={i}>
          <circle cx={dx} cy={dy} r="7.5" fill="#1A2888" stroke="#111" strokeWidth="1.5"/>
          <ellipse cx={dx-2} cy={dy-2} rx="2.5" ry="1.8" fill="rgba(100,140,255,0.45)"/>
        </g>
      ))}
      <circle r="22" fill="#E8B818"/><circle r="22" fill="none" stroke="#AA8010" strokeWidth="2.2"/>
      <path d="M -18,-9 A 19,19 0 0 1 18,-9" fill="none" stroke="rgba(255,255,240,0.55)" strokeWidth="3.5" strokeLinecap="round"/>
      <path d="M -22,0 A 22,22 0 0 0 22,0 L 18,0 A 18,18 0 0 1 -18,0 Z" fill="rgba(0,0,0,0.25)"/>
      <circle r="9" fill="#C89A10"/><circle r="9" fill="none" stroke="#8A6808" strokeWidth="1.5"/>
      <ellipse cx="-2" cy="-2.5" rx="3.5" ry="2.5" fill="rgba(255,255,200,0.5)"/>
      <circle cx="0" cy="46" r="6.5" fill="#CC1414" stroke="#111" strokeWidth="1.5"/>
      <ellipse cx="-1.5" cy="43.5" rx="2" ry="1.3" fill="rgba(255,180,180,0.5)"/>
    </motion.g>
  )

  return (
    <svg ref={svgRef} viewBox="-262 -118 524 264"
      style={{
        width:'100%', height:'100%', overflow:'visible', cursor:'pointer', touchAction:'none',
        filter:'drop-shadow(0 8px 22px rgba(0,0,0,0.9)) drop-shadow(0 22px 55px rgba(0,0,0,0.75))',
      }}
      onClick={onTap}>
      <Wings/><Tails/>

      {/* Left gear — PITCH */}
      <g transform="translate(-128,5)">
        <circle r="64" fill="#1A1A1A" opacity="0.4"/>
        <GearFace angle={leftAngle} snapping={leftSnapping}/>
        <circle r="62" fill="transparent" style={{ cursor:'grab', touchAction:'none' }}
          {...makeHandlers(lastAL, -128, 5, onLeftDragStart, onLeftDrag, onLeftDragEnd)}/>
        <text y="74" textAnchor="middle" fontSize="7.5" fill="rgba(255,200,100,0.8)"
          fontFamily="monospace" letterSpacing="1">{PITCH_LABELS[pitchIdx]}</text>
      </g>

      {/* Right gear — FX */}
      <g transform="translate(128,5)">
        <circle r="64" fill="#1A1A1A" opacity="0.4"/>
        <GearFace angle={rightAngle} snapping={rightSnapping}/>
        <circle r="62" fill="transparent" style={{ cursor:'grab', touchAction:'none' }}
          {...makeHandlers(lastAR, 128, 5, onRightDragStart, onRightDrag, onRightDragEnd)}/>
        <text y="74" textAnchor="middle" fontSize="7.5" fill="rgba(100,180,255,0.8)"
          fontFamily="monospace" letterSpacing="1">{FX_LABELS[fxIdx]}</text>
      </g>

      {/* Center knot */}
      <rect x="-22" y="-38" width="44" height="78" rx="4" fill="#18184A"/>
      <rect x="-22" y="-38" width="44" height="78" rx="4" fill="none" stroke="#0d0d2a" strokeWidth="1.8"/>
      <ellipse cx="0" cy="42" rx="13" ry="9" fill="#888898"/>
      <ellipse cx="0" cy="42" rx="13" ry="9" fill="none" stroke="#111" strokeWidth="1.5"/>
      <ellipse cx="-3" cy="38" rx="5" ry="3.5" fill="rgba(255,255,255,0.3)"/>
      {/* Column labels */}
      <text x="-128" y="-82" textAnchor="middle" fontSize="7" fill="rgba(255,200,100,0.55)"
        fontFamily="monospace" letterSpacing="2">PITCH</text>
      <text x="128" y="-82" textAnchor="middle" fontSize="7" fill="rgba(100,180,255,0.55)"
        fontFamily="monospace" letterSpacing="2">EFFECT</text>
    </svg>
  )
}

// ─── Front face 3D (Three.js) ─────────────────────────────────────────────────
function FrontFace3D({ isLive, onTap }: { isLive: boolean; onTap: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const liveRefs = useRef<{ ledMat: THREE.MeshPhongMaterial; ledLight: THREE.PointLight } | null>(null)

  useEffect(() => {
    const container = mountRef.current!
    const W = container.clientWidth || 524
    const H = container.clientHeight || 264

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(W, H)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    // FOV=20, z=756 → visible half-height ≈ 133 → full ≈ 266 matches SVG 264
    const camera = new THREE.PerspectiveCamera(20, W / H, 1, 3000)
    camera.position.z = 756

    // 4-point dramatic lighting
    scene.add(new THREE.AmbientLight(0x330800, 3))
    const key = new THREE.DirectionalLight(0xfff5ee, 5)
    key.position.set(120, 350, 500); key.castShadow = true; scene.add(key)
    const fill = new THREE.DirectionalLight(0xff3322, 2)
    fill.position.set(-400, 80, 300); scene.add(fill)
    const rim = new THREE.DirectionalLight(0x2244cc, 1.5)
    rim.position.set(0, -300, -300); scene.add(rim)
    const top = new THREE.DirectionalLight(0xffeedd, 1.2)
    top.position.set(50, 600, 200); scene.add(top)
    const ledLight = new THREE.PointLight(0x22FFCC, 0, 120)
    ledLight.position.set(0, 23, 60); scene.add(ledLight)

    // Shadow catcher
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.ShadowMaterial({ opacity: 0.45 })
    )
    shadowPlane.position.z = -90; shadowPlane.receiveShadow = true; scene.add(shadowPlane)

    // Materials
    const wingMat   = new THREE.MeshPhongMaterial({ color:0xBB1212, specular:0xff9999, shininess:100 })
    // Center knot = RED (matches the actual bow tie fabric)
    const knotMat   = new THREE.MeshPhongMaterial({ color:0xCC0E0E, specular:0xff7777, shininess:130 })
    const tailMat   = new THREE.MeshPhongMaterial({ color:0x8B0808, specular:0xcc5555, shininess:75 })
    const chromeMat = new THREE.MeshPhongMaterial({ color:0xC8C8D8, specular:0xffffff, shininess:600 })
    const speakerMat = new THREE.MeshPhongMaterial({ color:0x08080E, specular:0x222244, shininess:40 })
    const ledMat    = new THREE.MeshPhongMaterial({ color:0x1A2040, emissive:0x000000, emissiveIntensity:0, specular:0x88ffdd, shininess:200 })
    const creaseMat = new THREE.MeshPhongMaterial({ color:0x6A0404, specular:0x441111, shininess:40 })
    const creaseLitMat = new THREE.MeshPhongMaterial({ color:0xDD2020, specular:0xff9999, shininess:80 })

    const group = new THREE.Group()
    scene.add(group)

    // Wing shapes — Y flipped vs SVG
    const leftShape = new THREE.Shape()
    leftShape.moveTo(-26, 14)
    leftShape.bezierCurveTo(-55, 88, -172, 108, -228, 58)
    leftShape.bezierCurveTo(-258, 28, -255, -52, -218, -88)
    leftShape.bezierCurveTo(-178, -112, -85, -102, -26, -40)
    leftShape.closePath()

    const rightShape = new THREE.Shape()
    rightShape.moveTo(26, 14)
    rightShape.bezierCurveTo(55, 88, 172, 108, 228, 58)
    rightShape.bezierCurveTo(258, 28, 255, -52, 218, -88)
    rightShape.bezierCurveTo(178, -112, 85, -102, 26, -40)
    rightShape.closePath()

    const wingOpts = { depth:32, bevelEnabled:true, bevelThickness:14, bevelSize:9, bevelSegments:16 }
    const lGeo = new THREE.ExtrudeGeometry(leftShape,  wingOpts); lGeo.translate(0,0,-16)
    const rGeo = new THREE.ExtrudeGeometry(rightShape, wingOpts); rGeo.translate(0,0,-16)
    const lWing = new THREE.Mesh(lGeo, wingMat); lWing.castShadow = true
    const rWing = new THREE.Mesh(rGeo, wingMat); rWing.castShadow = true
    group.add(lWing, rWing)

    // ── Fabric wrinkle fold lines ───────────────────────────────────────────
    // Wrinkles radiate outward from the center-tie area, following drape lines
    const addFold = (pts: [number,number,number][], mat: THREE.Material, r = 1.6) => {
      const curve = new THREE.CatmullRomCurve3(pts.map(([x,y,z]) => new THREE.Vector3(x,y,z)))
      const geo = new THREE.TubeGeometry(curve, 30, r, 8, false)
      const m = new THREE.Mesh(geo, mat); m.castShadow = false
      group.add(m)
    }

    // Left wing folds (shadow = dark crease, highlight = lit ridge just beside it)
    addFold([[-30,8,17],[-80,14,18.5],[-145,8,18],[-198,-20,17],[-218,-52,16]], creaseMat)
    addFold([[-30,4,17.5],[-78,10,19],[-143,4,18.5],[-196,-24,17.5]], creaseLitMat, 0.8)

    addFold([[-30,-3,17],[-88,-2,18.5],[-155,-18,18],[-202,-50,17]], creaseMat)
    addFold([[-30,-7,17.5],[-86,-6,19],[-153,-22,18.5]], creaseLitMat, 0.8)

    addFold([[-30,-14,17],[-85,-22,18],[-148,-45,18],[-195,-72,16]], creaseMat)
    addFold([[-30,-18,17.5],[-83,-26,18.5],[-146,-49,18.5]], creaseLitMat, 0.8)

    // Right wing folds (mirror of left)
    addFold([[30,8,17],[80,14,18.5],[145,8,18],[198,-20,17],[218,-52,16]], creaseMat)
    addFold([[30,4,17.5],[78,10,19],[143,4,18.5],[196,-24,17.5]], creaseLitMat, 0.8)

    addFold([[30,-3,17],[88,-2,18.5],[155,-18,18],[202,-50,17]], creaseMat)
    addFold([[30,-7,17.5],[86,-6,19],[153,-22,18.5]], creaseLitMat, 0.8)

    addFold([[30,-14,17],[85,-22,18],[148,-45,18],[195,-72,16]], creaseMat)
    addFold([[30,-18,17.5],[83,-26,18.5],[146,-49,18.5]], creaseLitMat, 0.8)

    // Center knot — protrudes most, RED fabric
    const knotShape = new THREE.Shape()
    knotShape.moveTo(-24, 38); knotShape.lineTo(24, 38)
    knotShape.lineTo(24, -40); knotShape.lineTo(-24, -40); knotShape.closePath()
    const knotGeo = new THREE.ExtrudeGeometry(knotShape, { depth:56, bevelEnabled:true, bevelThickness:10, bevelSize:7, bevelSegments:12 })
    knotGeo.translate(0,0,-28)
    const knotMesh = new THREE.Mesh(knotGeo, knotMat); knotMesh.castShadow = true
    group.add(knotMesh)

    // Vertical crease on center knot (tying wrinkle)
    addFold([[0,36,29],[0,20,30],[0,0,30],[0,-20,30],[0,-38,29]], creaseMat, 1.2)

    // Tails
    const addTail = (s: number) => {
      const sh = new THREE.Shape()
      sh.moveTo(s*12,-40); sh.lineTo(s*22,-40); sh.lineTo(s*22,-128); sh.lineTo(s*12,-128); sh.closePath()
      const geo = new THREE.ExtrudeGeometry(sh, { depth:20, bevelEnabled:true, bevelThickness:6, bevelSize:4, bevelSegments:8 })
      geo.translate(0,0,-10)
      const m = new THREE.Mesh(geo, tailMat); m.castShadow = true; group.add(m)
    }
    addTail(-1); addTail(1)

    // Chrome ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(22, 3.8, 16, 64), chromeMat)
    ring.position.set(0, 10, 31)
    group.add(ring)

    // Speaker face
    const spk = new THREE.Mesh(new THREE.CylinderGeometry(17,17,5,32), speakerMat)
    spk.rotation.x = Math.PI/2; spk.position.set(0,10,28); group.add(spk)

    // Speaker dot grid
    const dotMat = new THREE.MeshPhongMaterial({ color:0x030308 })
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) if (r*r+c*c<7.5) {
      const d = new THREE.Mesh(new THREE.SphereGeometry(1.6,8,8), dotMat)
      d.position.set(c*5.5, 10+r*5.5, 31); group.add(d)
    }

    // LED
    const led = new THREE.Mesh(new THREE.SphereGeometry(3.5,16,16), ledMat)
    led.position.set(0,23,31); group.add(led)

    liveRefs.current = { ledMat, ledLight }

    // Animate — subtle breathing shows 3D depth
    let raf: number, t = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      t += 0.005
      group.position.y = Math.sin(t) * 2.5
      group.rotation.y = Math.sin(t * 0.55) * 0.07
      group.rotation.x = Math.sin(t * 0.38) * 0.018
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      renderer.dispose()
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => {
    if (!liveRefs.current) return
    const { ledMat, ledLight } = liveRefs.current
    ledMat.color.set(isLive ? 0x22FFCC : 0x1A2040)
    ledMat.emissive.set(isLive ? 0x22FFCC : 0x000000)
    ledMat.emissiveIntensity = isLive ? 1.5 : 0
    ledLight.intensity = isLive ? 3 : 0
    ledMat.needsUpdate = true
  }, [isLive])

  return (
    <div ref={mountRef}
      style={{
        width:'100%', height:'100%', cursor:'pointer',
        filter:[
          'drop-shadow(0 2px 4px rgba(0,0,0,1))',
          'drop-shadow(0 8px 22px rgba(0,0,0,0.9))',
          'drop-shadow(0 22px 55px rgba(0,0,0,0.75))',
          'drop-shadow(0 45px 110px rgba(0,0,0,0.55))',
        ].join(' '),
      }}
      onPointerDown={e => { e.preventDefault(); onTap() }}
    />
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [isFlipped,    setIsFlipped]    = useState(false)
  const [isLive,       setIsLive]       = useState(false)

  // Left gear = pitch, right gear = fx — fully independent
  const [leftAngle,    setLeftAngle]    = useState(2 * SNAP)  // starts at Normal (index 2)
  const [leftSnapping, setLeftSnapping] = useState(false)
  const [pitchIdx,     setPitchIdx]     = useState(2)

  const [rightAngle,    setRightAngle]    = useState(0)        // starts at Dry (index 0)
  const [rightSnapping, setRightSnapping] = useState(false)
  const [fxIdx,         setFxIdx]         = useState(0)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const pipelineRef = useRef<Pipeline | null>(null)

  const stopPipeline = useCallback(() => {
    pipelineRef.current?.stop(); pipelineRef.current = null; setIsLive(false)
  }, [])

  const startPipeline = useCallback(async (pi: number, fi: number) => {
    stopPipeline()
    try {
      const actx = audioCtxRef.current!
      if (actx.state === 'suspended') await actx.resume()
      if (!streamRef.current || !streamRef.current.active)
        streamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
        })
      const p = buildPipeline(actx, streamRef.current)
      pipelineRef.current = p
      p.setPitch(pi)
      p.setFx(fi)
      setIsLive(true)
    } catch { /* mic denied */ }
  }, [stopPipeline])

  const handleFrontTap = useCallback(async () => {
    if (isLive) { stopPipeline(); return }
    if (!audioCtxRef.current) {
      const AC = (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext
      audioCtxRef.current = new AC()
    }
    await startPipeline(pitchIdx, fxIdx)
  }, [isLive, pitchIdx, fxIdx, startPipeline, stopPipeline])

  const handleFlipToBack  = useCallback(() => setIsFlipped(true),  [])
  const handleFlipToFront = useCallback(() => setIsFlipped(false), [])

  // Left gear (pitch) handlers
  const handleLeftDrag = useCallback((d: number) => {
    setLeftAngle(prev => {
      const next = prev + d
      const idx = snapIdx(next)
      pipelineRef.current?.setPitch(idx)
      return next
    })
  }, [])
  const handleLeftDragEnd = useCallback(() => {
    setLeftSnapping(true)
    setLeftAngle(prev => {
      const snapped = Math.round(prev / SNAP) * SNAP
      const idx = snapIdx(snapped)
      setPitchIdx(idx)
      pipelineRef.current?.setPitch(idx)
      return snapped
    })
  }, [])

  // Right gear (fx) handlers
  const handleRightDrag = useCallback((d: number) => {
    setRightAngle(prev => {
      const next = prev + d
      const idx = snapIdx(next)
      pipelineRef.current?.setFx(idx)
      return next
    })
  }, [])
  const handleRightDragEnd = useCallback(() => {
    setRightSnapping(true)
    setRightAngle(prev => {
      const snapped = Math.round(prev / SNAP) * SNAP
      const idx = snapIdx(snapped)
      setFxIdx(idx)
      pipelineRef.current?.setFx(idx)
      return snapped
    })
  }, [])

  useEffect(() => () => {
    pipelineRef.current?.stop()
    streamRef.current?.getTracks().forEach(t => t.stop())
  }, [])

  return (
    <div style={{ width:'100vw', height:'100vh', background:'#080808', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden' }}>
      <div style={{ position:'absolute', inset:0, pointerEvents:'none', background:'radial-gradient(ellipse 50% 40% at 50% 50%, rgba(60,0,0,0.15) 0%, transparent 100%)' }}/>

      <div style={{ width:'min(98vw, calc(88vh * 1.98), 1020px)', aspectRatio:'524 / 264', perspective:'1100px', flexShrink:0 }}>
        <motion.div
          animate={{ rotateY: isFlipped ? 180 : 0 }}
          transition={{ duration:0.55, ease:[0.28,0,0.14,1] }}
          style={{ width:'100%', height:'100%', transformStyle:'preserve-3d', position:'relative' }}
        >
          {/* Front face */}
          <div style={{ position:'absolute', inset:0, backfaceVisibility:'hidden', WebkitBackfaceVisibility:'hidden' }}>
            <FrontFace3D isLive={isLive} onTap={handleFrontTap}/>
            <button
              onPointerDown={e => { e.stopPropagation(); handleFlipToBack() }}
              style={{
                position:'absolute', bottom:'10%', right:'3%',
                background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.18)',
                borderRadius:'50%', width:30, height:30, color:'rgba(255,255,255,0.45)',
                fontSize:14, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
                backdropFilter:'blur(4px)', touchAction:'none',
              }}
            >⚙</button>
            {!isLive && (
              <div style={{
                position:'absolute', bottom:'6%', left:'50%', transform:'translateX(-50%)',
                color:'rgba(255,255,255,0.25)', fontSize:10, fontFamily:'monospace',
                letterSpacing:2, pointerEvents:'none', userSelect:'none',
              }}>TAP TO SPEAK</div>
            )}
          </div>

          {/* Back face */}
          <div style={{ position:'absolute', inset:0, backfaceVisibility:'hidden', WebkitBackfaceVisibility:'hidden', transform:'rotateY(180deg)' }}>
            <BackFace
              leftAngle={leftAngle}   leftSnapping={leftSnapping}   pitchIdx={pitchIdx}
              rightAngle={rightAngle} rightSnapping={rightSnapping} fxIdx={fxIdx}
              onLeftDragStart={() => setLeftSnapping(false)}   onLeftDrag={handleLeftDrag}   onLeftDragEnd={handleLeftDragEnd}
              onRightDragStart={() => setRightSnapping(false)} onRightDrag={handleRightDrag} onRightDragEnd={handleRightDragEnd}
              onTap={handleFlipToFront}
            />
          </div>
        </motion.div>
      </div>
    </div>
  )
}
