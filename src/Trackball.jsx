import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";

// The real device, built procedurally: rounded-square shell, eight radial keys
// around the ball, the socket, the USB-C port and both corner encoder wheels.
// Ported from trackball3d.html — the geometry constants are that model's, so
// proportions match the hardware rather than being a stand-in sphere.
//
// It is still the preview: your settings change how it behaves under your
// finger, so "sensitivity 4x" is something you feel before you save it.

const HALF = 5.0;          // half-width of the shell
const CORNER = 1.75;       // corner radius
const BALL_R = 3.10;
const BALL_Y = 3.40;
const SOCKET = 3.28;
const BTN_IN = 3.44;       // inner edge of the key ring
const GAP = 0.13;          // gap between keys
const BTN_REST = 2.83;
const SPIN = 0.0068;
// ExtrudeGeometry's bevel pushes the shell's surface outward by bevelSize, so
// the real skin is HALF + this, not HALF. Everything mounted on the shell has
// to measure from there: the USB-C port was being swallowed by the wall, and
// the wheels stood proud by that much more than intended.
const SHELL_BEVEL = 0.3;
const FRONT = HALF + SHELL_BEVEL;

export const DEFAULT_COLOURS = {
  body: "#eeebe5",
  ball: "#a01730",
  wheel: "#4a4a52",
  keys: ["#ef6b6b", "#eceae4", "#ef6b6b", "#eceae4", "#eceae4", "#ef6b6b", "#eceae4", "#ef6b6b"],
};

const STORE = "anastasia-colours";
// The name was misspelled until now. Read the old key when the new one is
// empty, so a palette someone already picked survives the correction.
const STORE_WAS = "anastesia-colours";

const loadColours = () => {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || localStorage.getItem(STORE_WAS) || "null");
    if (!v) return DEFAULT_COLOURS;
    return {
      body: v.body ?? DEFAULT_COLOURS.body,
      ball: v.ball ?? DEFAULT_COLOURS.ball,
      wheel: v.wheel ?? DEFAULT_COLOURS.wheel,
      keys: Array.isArray(v.keys) && v.keys.length === 8 ? v.keys : DEFAULT_COLOURS.keys,
    };
  } catch {
    return DEFAULT_COLOURS;   // private windows and blocked storage both land here
  }
};

// Orbit presets. zoom multiplies the auto-fitted distance, so each frames the
// same way whatever size the panel is.
const VIEWS = {
  home: { az: 0.34, el: 0.46, zoom: 1 },
  top: { az: 0, el: 1.45, zoom: 1.06 },
  port: { az: Math.PI, el: 0.12, zoom: 0.72 },
  wheels: { az: 0.72, el: 0.2, zoom: 0.62 },
};

/** Cached WebGL probe, so callers can word their copy honestly. */
let webglOk = null;
export function hasWebGL() {
  if (webglOk === null) {
    try {
      const c = document.createElement("canvas");
      webglOk = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      webglOk = false;
    }
  }
  return webglOk;
}

const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function Trackball({ values, onScrollTick, tools = true, keyLabels }) {
  const host = useRef(null);
  const tags = useRef(null);
  // Shown by default — the whole point is seeing what the keys do — with a way
  // to clear them off when you would rather just look at the device.
  const [showTags, setShowTags] = useState(true);
  const labels = useRef(keyLabels);
  labels.current = showTags ? keyLabels : null;
  const api = useRef(null);
  const dot = useRef(null);
  const rpm = useRef(null);
  const live = useRef(values);
  live.current = values;

  const [colours, setColours] = useState(loadColours);
  const [palette, setPalette] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const el = host.current;

    // Locked-down and older devices have no WebGL; the app must still be usable.
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setSupported(false);
      el.dataset.fallback = "1";
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = true;
    // Not PCFSoftShadowMap: three deprecates it and substitutes this anyway,
    // warning once per frame while it does. A comment here said exactly that
    // and I removed it after finding the constant still exported — the export
    // survives, the behaviour does not.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // Only the ball and the wheels move, and both are surfaces of revolution
    // turning about their own axis — their shadows never change. So the shadow
    // pass runs once and is then frozen, which is most of the per-frame cost.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);

    const disposables = [];
    const track = (x) => { disposables.push(x); return x; };

    // ---------------------------------------------------------- textures
    const finish = (canvas, repeat) => {
      const t = track(new THREE.CanvasTexture(canvas));
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      if (repeat) t.repeat.set(repeat, repeat);
      return t;
    };

    const speckle = (specks, count, ribs, ribAlpha) => {
      const S = 512;
      const c = document.createElement("canvas");
      c.width = c.height = S;
      const g = c.getContext("2d");
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, S, S);
      if (ribs) {
        g.globalAlpha = ribAlpha ?? 0.06;
        for (let x = 0; x < S; x += 4) {
          g.fillStyle = "#000"; g.fillRect(x, 0, 1.5, S);
          g.fillStyle = "#fff"; g.fillRect(x + 2, 0, 1.2, S);
        }
        g.globalAlpha = 1;
      }
      for (let i = 0; i < count; i++) {
        g.fillStyle = specks[(Math.random() * specks.length) | 0];
        g.globalAlpha = 0.2 + Math.random() * 0.5;
        const r = 0.5 + Math.random() * 1.7;
        g.beginPath();
        g.ellipse(Math.random() * S, Math.random() * S, r, r * (0.6 + Math.random() * 0.9), Math.random() * 3.14, 0, 6.283);
        g.fill();
      }
      g.globalAlpha = 1;
      return c;
    };

    const shellMap = finish(speckle(["#6e6a63", "#9a958c", "#3c3934", "#ffffff"], 2200, false), 1.5);
    const keyMap = finish(speckle(["#6e6a63", "#9a958c", "#3c3934", "#ffffff"], 1800, true, 0.09), 2.2);

    const ballTexture = () => {
      const W = 1024, H = 512;
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const g = c.getContext("2d");
      g.fillStyle = "#8f8f8f";
      g.fillRect(0, 0, W, H);
      for (let i = 0; i < 150; i++) {
        const x = Math.random() * W, y = Math.random() * H, r = 50 + Math.random() * 200;
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        const bright = Math.random() > 0.5;
        grd.addColorStop(0, bright ? "rgba(215,215,215,0.55)" : "rgba(34,34,34,0.55)");
        grd.addColorStop(1, "rgba(143,143,143,0)");
        g.fillStyle = grd;
        g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
      }
      for (let j = 0; j < 4000; j++) {
        g.fillStyle = Math.random() > 0.5 ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.10)";
        g.fillRect(Math.random() * W, Math.random() * H, 1.2, 1.2);
      }
      const t = track(new THREE.CanvasTexture(c));
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    };

    // A studio in a canvas: cheaper than shipping an HDR, and enough to give
    // the ball's clearcoat something to reflect.
    const envTexture = () => {
      const W = 256, H = 128;
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const g = c.getContext("2d");
      const sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, "#3d3d47");
      sky.addColorStop(0.5, "#15151a");
      sky.addColorStop(1, "#08080b");
      g.fillStyle = sky;
      g.fillRect(0, 0, W, H);
      const box = (x, y, w, h, a) => {
        const grd = g.createRadialGradient(x, y, 0, x, y, Math.max(w, h));
        grd.addColorStop(0, `rgba(255,255,255,${a})`);
        grd.addColorStop(0.45, `rgba(255,255,255,${a * 0.5})`);
        grd.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grd;
        g.beginPath(); g.arc(x, y, Math.max(w, h), 0, 6.283); g.fill();
      };
      box(75, 25, 60, 15, 1);
      box(163, 18, 38, 11, 0.95);
      box(220, 38, 30, 25, 0.5);
      box(30, 48, 23, 9, 0.55);
      const t = new THREE.CanvasTexture(c);
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envSrc = envTexture();
    const envRT = pmrem.fromEquirectangular(envSrc);
    scene.environment = envRT.texture;
    envSrc.dispose();
    pmrem.dispose();

    // ---------------------------------------------------------- shapes
    // The shell is a rounded square, so a key's outer edge has to follow that
    // outline rather than a circle — hence the distance field search.
    const sdRoundedSquare = (x, y, half, r) => {
      const qx = Math.abs(x) - (half - r);
      const qy = Math.abs(y) - (half - r);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    };
    const edgeRadius = (theta, inset) => {
      let lo = 0, hi = HALF * 2;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (sdRoundedSquare(Math.sin(theta) * mid, Math.cos(theta) * mid, HALF, CORNER) < -inset) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const outerR = (theta) => edgeRadius(theta, 0.3);

    const roundedSquareShape = (half, r) => {
      const s = new THREE.Shape();
      const k = half - r;
      s.moveTo(-k, half);
      s.lineTo(k, half); s.quadraticCurveTo(half, half, half, k);
      s.lineTo(half, -k); s.quadraticCurveTo(half, -half, k, -half);
      s.lineTo(-k, -half); s.quadraticCurveTo(-half, -half, -half, -k);
      s.lineTo(-half, k); s.quadraticCurveTo(-half, half, -k, half);
      return s;
    };
    const flat = (m) => { m.rotation.x = -Math.PI / 2; };

    const rig = new THREE.Group();
    scene.add(rig);
    const add = (m) => { rig.add(m); return m; };

    // ---------------------------------------------------------- shell
    const shellMat = track(new THREE.MeshStandardMaterial({
      color: 0xeeebe5, map: shellMap, bumpMap: shellMap, bumpScale: 0.014,
      roughness: 0.78, metalness: 0, envMapIntensity: 0.34,
    }));
    const shell = add(new THREE.Mesh(track(new THREE.ExtrudeGeometry(roundedSquareShape(HALF, CORNER), {
      depth: 2.4, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.3,
      bevelSegments: 5, curveSegments: 24,
    })), shellMat));
    flat(shell); shell.position.y = 0.3;
    shell.castShadow = shell.receiveShadow = true;

    const seam = add(new THREE.Mesh(
      track(new THREE.ExtrudeGeometry(roundedSquareShape(HALF - 0.015, CORNER - 0.015), {
        depth: 0.05, bevelEnabled: false, curveSegments: 24,
      })),
      track(new THREE.MeshStandardMaterial({ color: 0x9d998f, roughness: 0.9 })),
    ));
    flat(seam); seam.position.y = 1.32;

    const trayShape = roundedSquareShape(HALF - 0.32, CORNER - 0.26);
    trayShape.holes.push(new THREE.Path().absarc(0, 0, SOCKET, 0, Math.PI * 2, true));
    const tray = add(new THREE.Mesh(
      track(new THREE.ExtrudeGeometry(trayShape, { depth: 0.14, bevelEnabled: false, curveSegments: 40 })),
      track(new THREE.MeshStandardMaterial({ color: 0x2b2926, roughness: 0.62, metalness: 0.1, envMapIntensity: 0.3 })),
    ));
    flat(tray); tray.position.y = 2.76; tray.receiveShadow = true;

    // ---------------------------------------------------------- keys
    const buttons = [];
    const keyMats = [];
    for (let i = 0; i < 8; i++) {
      const a0 = (i * 45) * Math.PI / 180;
      const a1 = ((i + 1) * 45) * Math.PI / 180;
      const shape = new THREE.Shape();
      const steps = 12;
      const padIn = GAP / BTN_IN;
      for (let s = 0; s <= steps; s++) {
        const t = a0 + padIn + (a1 - a0 - 2 * padIn) * (s / steps);
        const xi = Math.sin(t) * BTN_IN, yi = Math.cos(t) * BTN_IN;
        if (s === 0) shape.moveTo(xi, yi); else shape.lineTo(xi, yi);
      }
      for (let s = steps; s >= 0; s--) {
        const t0 = a0 + (a1 - a0) * (s / steps);
        const pad = GAP / outerR(t0);
        const t = Math.min(Math.max(t0, a0 + pad), a1 - pad);
        const r = outerR(t);
        shape.lineTo(Math.sin(t) * r, Math.cos(t) * r);
      }
      shape.closePath();
      const mat = track(new THREE.MeshStandardMaterial({
        map: keyMap, bumpMap: keyMap, bumpScale: 0.03,
        roughness: 0.78, metalness: 0, envMapIntensity: 0.5,
      }));
      keyMats.push(mat);
      const key = add(new THREE.Mesh(track(new THREE.ExtrudeGeometry(shape, {
        depth: 0.3, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.09,
        bevelSegments: 3, curveSegments: 14,
      })), mat));
      flat(key); key.position.y = BTN_REST;
      key.castShadow = key.receiveShadow = true;
      key.userData.press = 0;
      buttons.push(key);
    }

    // ---------------------------------------------------------- socket + ball
    const darkMat = track(new THREE.MeshStandardMaterial({
      color: 0x131211, roughness: 0.55, metalness: 0.2, envMapIntensity: 0.4,
    }));
    const socket = add(new THREE.Mesh(
      track(new THREE.CylinderGeometry(SOCKET, SOCKET - 0.1, 1.6, 48, 1, true)), darkMat,
    ));
    socket.position.y = 2.3;
    const socketFloor = add(new THREE.Mesh(track(new THREE.CircleGeometry(SOCKET, 40)), darkMat));
    socketFloor.rotation.x = -Math.PI / 2;
    socketFloor.position.y = 1.55;

    const ballMat = track(new THREE.MeshPhysicalMaterial({
      map: ballTexture(), color: 0xa01730, roughness: 0.075, metalness: 0,
      clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.35, reflectivity: 0.8,
    }));
    const ball = add(new THREE.Mesh(track(new THREE.SphereGeometry(BALL_R, 48, 48)), ballMat));
    ball.position.y = BALL_Y;
    ball.castShadow = true;

    // Flares when the dead zone swallows a movement.
    const deadRing = add(new THREE.Mesh(
      track(new THREE.TorusGeometry(SOCKET + 0.06, 0.05, 10, 64)),
      track(new THREE.MeshBasicMaterial({ color: 0xffa06a, transparent: true, opacity: 0 })),
    ));
    deadRing.rotation.x = Math.PI / 2;
    deadRing.position.y = 2.9;

    // ---------------------------------------------------------- USB-C port
    // The wheels sit on the +Z corners, so the port goes on the opposite face.
    // Turning a group 180 degrees keeps every local +Z offset below as written.
    const portGroup = new THREE.Group();
    portGroup.rotation.y = Math.PI;
    rig.add(portGroup);
    const addPort = (m) => { portGroup.add(m); return m; };

    const panel = addPort(new THREE.Mesh(
      track(new THREE.BoxGeometry(5.8, 1.85, 0.1)),
      track(new THREE.MeshStandardMaterial({ color: 0x181717, roughness: 0.42, metalness: 0.25, envMapIntensity: 0.5 })),
    ));
    panel.position.set(0, 1.35, FRONT - 0.06);

    const racetrack = (w, h, r) => {
      const s = new THREE.Shape();
      s.moveTo(-w + r, h); s.lineTo(w - r, h); s.quadraticCurveTo(w, h, w, 0);
      s.quadraticCurveTo(w, -h, w - r, -h); s.lineTo(-w + r, -h);
      s.quadraticCurveTo(-w, -h, -w, 0); s.quadraticCurveTo(-w, h, -w + r, h);
      return s;
    };
    const rimShape = racetrack(0.92, 0.36, 0.36);
    const holePts = racetrack(0.7, 0.2, 0.2).getPoints(28);
    const hole = new THREE.Path();
    hole.moveTo(holePts[0].x, holePts[0].y);
    for (let hp = holePts.length - 1; hp > 0; hp--) hole.lineTo(holePts[hp].x, holePts[hp].y);
    rimShape.holes.push(hole);

    const portRing = addPort(new THREE.Mesh(
      track(new THREE.ExtrudeGeometry(rimShape, {
        depth: 0.2, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05,
        bevelSegments: 2, curveSegments: 14,
      })),
      track(new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.15, metalness: 1, envMapIntensity: 1.7 })),
    ));
    portRing.position.set(0, 1.35, FRONT - 0.05);

    const portCavity = addPort(new THREE.Mesh(
      track(new THREE.BoxGeometry(1.44, 0.42, 0.1)),
      track(new THREE.MeshStandardMaterial({ color: 0x040405, roughness: 0.75 })),
    ));
    portCavity.position.set(0, 1.35, FRONT + 0.06);
    const tongue = addPort(new THREE.Mesh(
      track(new THREE.BoxGeometry(1.06, 0.13, 0.05)),
      track(new THREE.MeshStandardMaterial({ color: 0xa5a8ad, roughness: 0.28, metalness: 0.95 })),
    ));
    tongue.position.set(0, 1.35, FRONT + 0.09);

    // ---------------------------------------------------------- encoder wheels
    const treadTex = (() => {
      const S = 256;
      const c = document.createElement("canvas");
      c.width = c.height = S;
      const g = c.getContext("2d");
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, S, S);
      for (let x = 0; x < S; x += 6) {
        g.fillStyle = "#2a2a2a"; g.fillRect(x, 0, 3, S);
        g.fillStyle = "#e0e0e0"; g.fillRect(x + 3, 0, 1.5, S);
      }
      const t = track(new THREE.CanvasTexture(c));
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.repeat.set(6, 1);
      return t;
    })();
    const wheelMat = track(new THREE.MeshStandardMaterial({
      color: 0x4a4a52, map: treadTex, bumpMap: treadTex, bumpScale: 0.12,
      roughness: 0.55, metalness: 0.35, envMapIntensity: 1.1,
    }));

    // The shell corner is a quadratic Bezier, not a circular arc: it bulges to
    // ~1.86 from the corner centre, putting the surface 6.456 from the origin
    // along the diagonal. The wheel is sized so a band of tread clears that,
    // and its flat caps stay buried inside the shell.
    const CORNER_SURFACE = 3.25 * Math.SQRT2 + 1.86 + SHELL_BEVEL;
    const WHEEL_R = 1.25;
    const PROUD = 0.2;   // how far the tread clears the shell   // how far the tread clears the shell
    const WHEEL_DIST = CORNER_SURFACE + PROUD - WHEEL_R;
    const wheels = [];
    for (const sx of [1, -1]) {
      const outward = new THREE.Vector3(sx, 0, 1).normalize();
      const wheel = add(new THREE.Mesh(
        track(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 1.05, 32, 1, false)), wheelMat,
      ));
      wheel.position.copy(outward).multiplyScalar(WHEEL_DIST).setY(0.95);
      wheel.castShadow = true;
      wheel.userData.spin = 0;
      wheels.push(wheel);
    }

    const footMat = track(new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.92 }));
    const footGeo = track(new THREE.CylinderGeometry(0.45, 0.45, 0.1, 14));
    for (const [x, z] of [[-3.3, -3.3], [3.3, -3.3], [-3.3, 3.3], [3.3, 3.3]]) {
      const f = add(new THREE.Mesh(footGeo, footMat));
      f.position.set(x, 0.05, z);
    }

    // Shadow catcher. It goes straight on the scene, not the rig: it is 40
    // units wide, and inside the rig it would dominate the bounding box the
    // camera fits to and leave the device a speck in the middle of the frame.
    const ground = new THREE.Mesh(
      track(new THREE.PlaneGeometry(40, 40)),
      track(new THREE.ShadowMaterial({ opacity: 0.55 })),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // ---------------------------------------------------------- light
    // Ambient at 0.9 was lighting every face of the shell equally, so the body
    // read as a white cut-out rather than a moulded object: 54.8% of its pixels
    // were above 200. It drops to a trace, and the job it was doing badly — not
    // letting the unlit side go black — passes to a directional fill opposite
    // the key, which shades across a surface instead of flooding it. The
    // environment map already supplies the soft wrap that ambient cannot.
    scene.add(new THREE.AmbientLight(0xffffff, 0.10));
    const fillLight = new THREE.DirectionalLight(0xd8e2ff, 0.55);
    fillLight.position.set(8, 3, 11);
    scene.add(fillLight);
    const keyLight = new THREE.DirectionalLight(0xfff5ea, 2.35);
    keyLight.position.set(-7, 16, 9);
    keyLight.castShadow = true;
    // The frustum was 26 units across for a device 9 wide, so most of the map
    // fell on empty floor and the shadow arrived as a grey smear. Tightened to
    // the device plus its throw, with four times the texels over it.
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.left = -8; keyLight.shadow.camera.right = 8;
    keyLight.shadow.camera.top = 8; keyLight.shadow.camera.bottom = -8;
    keyLight.shadow.camera.near = 1; keyLight.shadow.camera.far = 48;
    keyLight.shadow.bias = -0.0011;
    keyLight.shadow.radius = 1.6;
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x8fb8ff, 1.7);
    rimLight.position.set(9, 6, -10);
    scene.add(rimLight);

    // The board's own RGB: an underglow that follows the Lighting settings.
    const glow = new THREE.PointLight(0x7cd4ff, 0, 24, 2);
    glow.position.set(0, 1.1, 0);
    scene.add(glow);

    // The model's keys, ordered by where they sit rather than by the order
    // they happened to be built in. The keymap is sorted the same way, so the
    // two line up without either side knowing the other's indices.
    // Where a key actually is, which is not where its mesh is. These are
    // extruded shapes whose vertices carry the position, so every button's
    // own transform sits at the origin and getWorldPosition returns the middle
    // of the ball for all eight of them. The centre of the geometry is the
    // real answer; cached in local space so the render loop can transform it
    // each frame as the key presses in and out.
    for (const b of buttons) {
      b.geometry.computeBoundingBox();
      const box = b.geometry.boundingBox;
      b.userData.centre = box.getCenter(new THREE.Vector3());
      // The eight corners, so the render loop can measure how wide the key is
      // on screen right now. A label is then held to its own key rather than
      // running across its neighbours — which is what "nowrap" was doing.
      b.userData.corners = [
        new THREE.Vector3(box.min.x, box.min.y, box.min.z),
        new THREE.Vector3(box.min.x, box.min.y, box.max.z),
        new THREE.Vector3(box.min.x, box.max.y, box.min.z),
        new THREE.Vector3(box.min.x, box.max.y, box.max.z),
        new THREE.Vector3(box.max.x, box.min.y, box.min.z),
        new THREE.Vector3(box.max.x, box.min.y, box.max.z),
        new THREE.Vector3(box.max.x, box.max.y, box.min.z),
        new THREE.Vector3(box.max.x, box.max.y, box.max.z),
      ];
    }

    const ringed = buttons
      .map((b) => {
        const p = b.userData.centre.clone();
        b.localToWorld(p);
        // Same normalisation as the layout side: a key on the pi boundary
        // must not swap ends of the ring on the sign of a zero.
        return { mesh: b, angle: (Math.atan2(p.z, p.x) + Math.PI * 2) % (Math.PI * 2) };
      })
      .sort((a, b) => a.angle - b.angle)
      .map((k) => k.mesh);

    // ---------------------------------------------------------- camera
    const bounds = new THREE.Box3().setFromObject(rig);
    const centre = bounds.getCenter(new THREE.Vector3());
    const corners = [];
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          corners.push(new THREE.Vector3(x, y, z).sub(centre));
        }
      }
    }

    const view = { ...VIEWS.home };
    let fitDist = 24;

    /**
     * Distance at which every bounding-box corner sits inside both fields of
     * view. Solving the corners beats a bounding-sphere estimate, which leaves
     * a wide flat device marooned in the middle of the frame.
     */
    const fitFor = (az, elev) => {
      const eye = new THREE.Vector3(
        Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az),
      ).normalize();
      const right = new THREE.Vector3().crossVectors(eye, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, eye).normalize();
      const tanV = Math.tan((camera.fov * Math.PI) / 360);
      const tanH = tanV * camera.aspect;
      let d = 0;
      for (const p of corners) {
        const along = p.dot(eye);
        d = Math.max(d, along + Math.abs(p.dot(right)) / tanH, along + Math.abs(p.dot(up)) / tanV);
      }
      return d * 1.04;
    };

    // A bounding-box centre is not an optical centre. Looking at it left the
    // device sitting low with 187px of air above and 41 below at 1280, and the
    // imbalance grew with the viewport: 263 against 46 at 1920. So after the
    // fit, project the silhouette and pan until its middle is the frame's.
    // Two passes converge; the pan is in view space, so it holds at any aspect.
    const target = new THREE.Vector3();
    const camUp = new THREE.Vector3();
    const scratch = new THREE.Vector3();
    // A hair above true centre. Optical centre reads slightly high, and the
    // contact shadow occupies the space below the device.
    const LOOK_BIAS = 0.04;

    const placeCamera = () => {
      const d = fitDist * view.zoom;
      const aim = () => {
        camera.position.set(
          target.x + d * Math.cos(view.el) * Math.sin(view.az),
          target.y + d * Math.sin(view.el),
          target.z + d * Math.cos(view.el) * Math.cos(view.az),
        );
        camera.lookAt(target);
        camera.updateMatrixWorld();
      };
      target.copy(centre);
      aim();
      const halfH = d * Math.tan((camera.fov * Math.PI) / 360);
      for (let pass = 0; pass < 2; pass++) {
        let lo = Infinity, hi = -Infinity;
        for (const p of corners) {
          scratch.copy(p).add(centre).project(camera);
          lo = Math.min(lo, scratch.y); hi = Math.max(hi, scratch.y);
        }
        const off = (lo + hi) / 2 - LOOK_BIAS;
        if (Math.abs(off) < 0.002) break;
        camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
        target.addScaledVector(camUp, off * halfH);
        aim();
      }
      renderer.shadowMap.needsUpdate = true;
    };

    // ---------------------------------------------------------- input
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let mode = null;
    let lastX = 0, lastY = 0, velX = 0, velY = 0;
    let deadFlash = 0;
    let twistAcc = 0;
    // Where the pointer would have travelled, in pad pixels.
    const cursor = { x: 0, y: 0 };
    const reduced = reducedMotion();
    const DAMP = reduced ? 0.9 : 0.972;

    const setNDC = (e) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };

    /** Roll about the camera axes, so the ball follows your hand. */
    const rollBall = (dx, dy) => {
      const v = live.current;
      const mag = Math.hypot(dx, dy);

      // Below the threshold the firmware reports nothing at all.
      if (v.deadzone && mag <= (v.deadzoneSize ?? 0) * 0.4) {
        deadFlash = 1;
        return;
      }
      // A rotated tracking plane turns the movement before it is applied.
      const a = ((v.plane ?? 0) * Math.PI) / 180;
      const rx = dx * Math.cos(a) - dy * Math.sin(a);
      const ry = dx * Math.sin(a) + dy * Math.cos(a);
      const gain = SPIN * (v.sens ?? 1) * 0.55;

      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      const q = new THREE.Quaternion();
      q.setFromAxisAngle(up, rx * gain); ball.quaternion.premultiply(q);
      q.setFromAxisAngle(right, ry * gain); ball.quaternion.premultiply(q);

      // The pad shows the pointer this roll would produce, at your settings.
      cursor.x += rx * 0.55 * (v.sens ?? 1) * 0.4;
      cursor.y += ry * 0.55 * (v.sens ?? 1) * 0.4;

      if (v.twist) {
        twistAcc += Math.abs(rx) * (v.twistSens ?? 1);
        if (twistAcc > 60) {
          twistAcc = 0;
          // The wheels are separate hardware from the ball, so rolling the
          // ball must not turn them. Only clicking one does.
          onScrollTick?.(Math.sign(rx));
        }
      }
    };

    // Grab the ball and it rolls; grab anywhere else and the device turns.
    // Clicking a key presses it, clicking a wheel spins it.
    const onPointerDown = (e) => {
      // Capture is a nicety, not a requirement. It throws in some environments
      // and it used to be the first statement here, so a failure took the rest
      // of the handler with it and dragging silently stopped working.
      try { el.setPointerCapture?.(e.pointerId); } catch { /* drag still works */ }
      setNDC(e);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.intersectObject(ball).length) {
        mode = "ball";
        velX = velY = 0;
      } else {
        const hitWheel = raycaster.intersectObjects(wheels)[0];
        if (hitWheel) hitWheel.object.userData.spin = 7.5;
        const hitKey = raycaster.intersectObjects(buttons)[0];
        if (hitKey) hitKey.object.userData.press = 1;
        mode = "orbit";
      }
      el.dataset.grabbing = "1";
      lastX = e.clientX; lastY = e.clientY;
    };

    const onPointerMove = (e) => {
      if (!mode) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (mode === "ball") {
        rollBall(dx, dy);
        velX = velX * 0.55 + dx * 0.45;
        velY = velY * 0.55 + dy * 0.45;
      } else {
        view.az -= dx * 0.006;
        view.el = Math.min(1.5, Math.max(0.02, view.el + dy * 0.005));
        fitDist = fitFor(view.az, view.el);
        placeCamera();
      }
    };

    const onPointerUp = (e) => {
      mode = null;
      delete el.dataset.grabbing;
      try { el.releasePointerCapture?.(e.pointerId); } catch { /* never captured */ }
    };

    const zoomBy = (d) => {
      view.zoom = Math.min(1.6, Math.max(0.42, view.zoom + d));
      placeCamera();
    };
    const onWheel = (e) => { e.preventDefault(); zoomBy(e.deltaY * 0.0012); };

    let pinch = 0;
    const onTouchMove = (e) => {
      if (e.touches.length !== 2) return;
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      if (pinch) zoomBy((pinch - d) * 0.003);
      pinch = d;
    };
    const onTouchEnd = () => { pinch = 0; };

    // Arrows roll the ball, shift+arrows turn the device, +/- zoom, so all of
    // it is reachable without a pointer.
    const onKey = (e) => {
      const step = 26;
      const map = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
        ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(-0.08); return; }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(0.08); return; }
      if (!map[e.key]) return;
      e.preventDefault();
      const [dx, dy] = map[e.key];
      if (e.shiftKey) {
        view.az -= dx * 0.02;
        view.el = Math.min(1.5, Math.max(0.02, view.el + dy * 0.015));
        fitDist = fitFor(view.az, view.el);
        placeCamera();
      } else {
        rollBall(dx, dy);
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("keydown", onKey);

    // ---------------------------------------------------------- resize
    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      fitDist = fitFor(view.az, view.el);
      placeCamera();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // ---------------------------------------------------------- api
    api.current = {
      applyColours(c) {
        shellMat.color.set(c.body);
        ballMat.color.set(c.ball);
        wheelMat.color.set(c.wheel);
        c.keys.forEach((hex, i) => keyMats[i]?.color.set(hex));
      },
      setView(name) {
        Object.assign(view, VIEWS[name] ?? VIEWS.home);
        fitDist = fitFor(view.az, view.el);
        placeCamera();
      },
      flick() {
        velX = 26 + Math.random() * 16;
        velY = -9 + Math.random() * 18;
      },
    };

    // ---------------------------------------------------------- loop
    const timer = new THREE.Timer();   // Clock is deprecated
    let raf;
    let visible = true;
    let acc = 0;
    const FRAME = 1 / 30;
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    io.observe(el);

    const spinAxis = new THREE.Vector3(0, 1, 0);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      timer.update();
      const dt = Math.min(timer.getDelta(), 0.05);
      if (!visible || document.hidden) return;
      acc += dt;
      if (acc < FRAME) return;
      const step = acc;
      acc = 0;
      const v = live.current;

      // The ball keeps rolling after you let go. Smoothing lengthens the
      // coast, the way a larger averaging window does on the hardware.
      if (mode !== "ball" && (Math.abs(velX) > 0.02 || Math.abs(velY) > 0.02)) {
        rollBall(velX * step * 30, velY * step * 30);
        const d = Math.pow(DAMP, (step * 60) / Math.max(1, (v.sma ?? 1) * 0.4));
        velX *= d;
        velY *= d;
      }

      // Bindings float over their own keys. Positions are written straight to
      // the DOM here rather than through state: this runs every frame, and a
      // re-render per frame would take the settings panel with it.
      if (tags.current && labels.current?.length) {
        const box = renderer.domElement.getBoundingClientRect();
        const v = new THREE.Vector3();
        const c = new THREE.Vector3();
        ringed.forEach((mesh, i) => {
          const el = tags.current.children[i];
          if (!el) return;
          const text = labels.current[i];
          if (!text) { el.hidden = true; return; }
          v.copy(mesh.userData.centre);
          mesh.localToWorld(v);
          v.project(camera);
          // Behind the camera, or off the frame: hide rather than smear it
          // against an edge.
          if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) { el.hidden = true; return; }
          el.hidden = false;
          if (el.textContent !== text) el.textContent = text;
          el.style.left = `${((v.x + 1) / 2) * box.width}px`;
          el.style.top = `${((1 - v.y) / 2) * box.height}px`;

          // How wide this key is on screen, so the label can be kept inside it.
          let lo = Infinity, hi = -Infinity;
          for (const corner of mesh.userData.corners) {
            c.copy(corner);
            mesh.localToWorld(c);
            c.project(camera);
            const px = ((c.x + 1) / 2) * box.width;
            if (px < lo) lo = px;
            if (px > hi) hi = px;
          }
          // A little inside the key, so the legend sits on the cap rather than
          // running to its very edge.
          el.style.maxWidth = `${Math.max(28, (hi - lo) * 0.88)}px`;
        });
      }

      for (const b of buttons) {
        if (b.userData.press > 0) {
          b.userData.press = Math.max(0, b.userData.press - step * 3.6);
          b.position.y = BTN_REST - Math.sin(b.userData.press * Math.PI) * 0.11;
        }
      }

      for (const w of wheels) {
        if (Math.abs(w.userData.spin) > 0.01) {
          w.rotateOnAxis(spinAxis, w.userData.spin * step);
          cursor.y -= w.userData.spin * step * 5;
          w.userData.spin *= Math.pow(0.94, step * 60);
        }
      }

      deadFlash = Math.max(0, deadFlash - step * 2.4);
      deadRing.material.opacity = deadFlash * 0.9;

      const bright = v.glow ? (v.brightness ?? 60) / 100 : 0;
      glow.intensity = THREE.MathUtils.lerp(glow.intensity, bright * 26, 0.08);

      // Pointer output readout. Written straight to the DOM: it changes every
      // frame, and routing that through React state would re-render the panel.
      if (dot.current) {
        const pad = dot.current.parentElement;
        const hx = pad.clientWidth / 2 - 6;
        const hy = pad.clientHeight / 2 - 6;
        cursor.x = Math.max(-hx, Math.min(hx, cursor.x));
        cursor.y = Math.max(-hy, Math.min(hy, cursor.y));
        dot.current.style.transform =
          `translate(${cursor.x.toFixed(1)}px, ${cursor.y.toFixed(1)}px)`;
      }
      if (rpm.current) {
        const turns = Math.hypot(velX, velY) * SPIN * 3600 / (2 * Math.PI);
        rpm.current.textContent = turns < 1 ? "0" : turns.toFixed(0);
      }

      renderer.render(scene, camera);
    };
    tick();

    // A gentle roll on arrival, so it reads as a thing that moves.
    if (!reduced) { velX = 12; velY = 4; }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      api.current = null;
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("keydown", onKey);
      for (const d of disposables) d.dispose?.();
      envRT.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [onScrollTick]);

  // Colours live in React so the pickers are controlled; the scene is told
  // whenever they change, including on first mount.
  useEffect(() => {
    api.current?.applyColours(colours);
    try { localStorage.setItem(STORE, JSON.stringify(colours)); } catch { /* storage may be blocked */ }
  }, [colours]);

  const setPart = useCallback((part, hex) => {
    setColours((c) => ({ ...c, [part]: hex }));
  }, []);
  const setKeyColour = useCallback((i, hex) => {
    setColours((c) => ({ ...c, keys: c.keys.map((k, n) => (n === i ? hex : k)) }));
  }, []);

  return (
    <div className="viewport">
      <div
        ref={host}
        className="ball"
        tabIndex={0}
        role="application"
        aria-label="Trackball preview. Drag the ball to roll it, drag the body to turn the device, scroll to zoom. Arrow keys roll, shift with arrows turns, plus and minus zoom."
      />

      {/* One span per key on the model, moved to its key every frame. Hidden
          until something gives it a label, so the model is uncluttered unless
          the keymap editor is open with a keymap read. */}
      {supported && showTags && keyLabels?.length > 0 && (
        <div className="keytags" ref={tags} aria-hidden="true">
          {keyLabels.map((_, i) => <span key={i} className="keytag" hidden />)}
        </div>
      )}

      {supported && tools && (
        <div className="pad" aria-hidden="true">
          <span className="pad__label">Pointer output</span>
          <div className="pad__box">
            <span className="pad__dot" ref={dot} />
          </div>
          <span className="pad__rpm">Ball speed <b ref={rpm}>0</b> rpm</span>
        </div>
      )}

      {supported && tools && (
        <div className="viewport__tools">
          {keyLabels?.length > 0 && (
            <button
              className={"vbtn" + (showTags ? " is-on" : "")}
              onClick={() => setShowTags((v) => !v)}
              aria-pressed={showTags}
            >
              Keys
            </button>
          )}
          <button className="vbtn" onClick={() => api.current?.setView("home")}>Reset</button>
          <button className="vbtn" onClick={() => api.current?.setView("top")}>Top</button>
          <button className="vbtn" onClick={() => api.current?.setView("port")}>Port</button>
          <button className="vbtn" onClick={() => api.current?.setView("wheels")}>Wheels</button>
          <button className="vbtn" onClick={() => api.current?.flick()}>Flick</button>
          <button
            className={"vbtn" + (palette ? " is-on" : "")}
            aria-pressed={palette}
            aria-expanded={palette}
            onClick={() => setPalette((v) => !v)}
          >
            Colours
          </button>
        </div>
      )}

      {palette && supported && tools && (
        <div className="palette" role="group" aria-label="Part colours">
          <Swatch label="Body" value={colours.body} onChange={(v) => setPart("body", v)} />
          <Swatch label="Ball" value={colours.ball} onChange={(v) => setPart("ball", v)} />
          <Swatch label="Wheels" value={colours.wheel} onChange={(v) => setPart("wheel", v)} />
          <p className="palette__head">Keys</p>
          <div className="palette__keys">
            {colours.keys.map((hex, i) => (
              <input
                key={i}
                type="color"
                value={hex}
                aria-label={`Key ${i + 1} colour`}
                onChange={(e) => setKeyColour(i, e.target.value)}
              />
            ))}
          </div>
          <button className="vbtn" onClick={() => setColours(DEFAULT_COLOURS)}>Reset colours</button>
        </div>
      )}
    </div>
  );
}

function Swatch({ label, value, onChange }) {
  return (
    <label className="palette__row">
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
