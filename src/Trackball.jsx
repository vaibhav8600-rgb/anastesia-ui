import { useEffect, useRef } from "react";
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
const ACCENT_KEYS = { 0: 1, 2: 1, 5: 1, 7: 1 };

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

export default function Trackball({ values, onScrollTick }) {
  const host = useRef(null);
  const live = useRef(values);
  live.current = values;

  useEffect(() => {
    const el = host.current;

    // Locked-down and older devices have no WebGL; the app must still be usable.
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      el.dataset.fallback = "1";
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
      roughness: 0.78, metalness: 0, envMapIntensity: 0.5,
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
        color: ACCENT_KEYS[i] ? 0xef6b6b : 0xeceae4,
        map: keyMap, bumpMap: keyMap, bumpScale: 0.03,
        roughness: ACCENT_KEYS[i] ? 0.84 : 0.74, metalness: 0, envMapIntensity: 0.5,
      }));
      const key = add(new THREE.Mesh(track(new THREE.ExtrudeGeometry(shape, {
        depth: 0.3, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.09,
        bevelSegments: 3, curveSegments: 14,
      })), mat));
      flat(key); key.position.y = BTN_REST;
      key.castShadow = key.receiveShadow = true;
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
    const panel = add(new THREE.Mesh(
      track(new THREE.BoxGeometry(5.8, 1.85, 0.1)),
      track(new THREE.MeshStandardMaterial({ color: 0x181717, roughness: 0.42, metalness: 0.25, envMapIntensity: 0.5 })),
    ));
    panel.position.set(0, 1.35, HALF - 0.03);

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

    const portRing = add(new THREE.Mesh(
      track(new THREE.ExtrudeGeometry(rimShape, {
        depth: 0.2, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05,
        bevelSegments: 2, curveSegments: 14,
      })),
      track(new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.15, metalness: 1, envMapIntensity: 1.7 })),
    ));
    portRing.position.set(0, 1.35, HALF - 0.02);

    const portCavity = add(new THREE.Mesh(
      track(new THREE.BoxGeometry(1.44, 0.42, 0.1)),
      track(new THREE.MeshStandardMaterial({ color: 0x040405, roughness: 0.75 })),
    ));
    portCavity.position.set(0, 1.35, HALF + 0.09);
    const tongue = add(new THREE.Mesh(
      track(new THREE.BoxGeometry(1.06, 0.13, 0.05)),
      track(new THREE.MeshStandardMaterial({ color: 0xa5a8ad, roughness: 0.28, metalness: 0.95 })),
    ));
    tongue.position.set(0, 1.35, HALF + 0.12);

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
    const CORNER_SURFACE = 3.25 * Math.SQRT2 + 1.86;
    const WHEEL_R = 1.25;
    const PROUD = 0.72;   // how far the tread clears the shell
    const WHEEL_DIST = CORNER_SURFACE + PROUD - WHEEL_R;
    const wheels = [];
    for (const sx of [1, -1]) {
      const outward = new THREE.Vector3(sx, 0, 1).normalize();
      const wheel = add(new THREE.Mesh(
        track(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 1.05, 32, 1, false)), wheelMat,
      ));
      wheel.position.copy(outward).multiplyScalar(WHEEL_DIST).setY(0.95);
      wheel.castShadow = true;
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
      track(new THREE.ShadowMaterial({ opacity: 0.4 })),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // ---------------------------------------------------------- light
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const keyLight = new THREE.DirectionalLight(0xfff5ea, 2.6);
    keyLight.position.set(-7, 16, 9);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -13; keyLight.shadow.camera.right = 13;
    keyLight.shadow.camera.top = 13; keyLight.shadow.camera.bottom = -13;
    keyLight.shadow.camera.near = 1; keyLight.shadow.camera.far = 48;
    keyLight.shadow.bias = -0.0011;
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x8fb8ff, 1.4);
    rimLight.position.set(9, 6, -10);
    scene.add(rimLight);

    // The board's own RGB: an underglow that follows the Lighting settings.
    const glow = new THREE.PointLight(0x7cd4ff, 0, 24, 2);
    glow.position.set(0, 1.1, 0);
    scene.add(glow);

    // ---------------------------------------------------------- input
    const vel = new THREE.Vector2();
    const smoothed = new THREE.Vector2();
    let dragging = false;
    let last = null;
    let deadFlash = 0;
    let twistAcc = 0;
    let wheelSpin = 0;

    function apply(dx, dy) {
      const v = live.current;
      const mag = Math.hypot(dx, dy);

      // Below the threshold the firmware reports nothing at all.
      if (v.deadzone && mag <= (v.deadzoneSize ?? 0) * 0.4) {
        deadFlash = 1;
        return;
      }

      const a = ((v.plane ?? 0) * Math.PI) / 180;
      const rx = dx * Math.cos(a) - dy * Math.sin(a);
      const ry = dx * Math.sin(a) + dy * Math.cos(a);

      const gain = 0.0007 * (v.sens ?? 1);
      vel.x += ry * gain;
      vel.y += rx * gain;

      if (v.twist) {
        twistAcc += Math.abs(rx) * (v.twistSens ?? 1);
        if (twistAcc > 60) {
          twistAcc = 0;
          wheelSpin = Math.sign(rx) * 6;
          onScrollTick?.(Math.sign(rx));
        }
      }
    }

    const onPointerDown = (e) => {
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e) => {
      if (!dragging) return;
      apply(e.clientX - last.x, e.clientY - last.y);
      last = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e) => {
      dragging = false;
      el.releasePointerCapture?.(e.pointerId);
    };
    const nudges = {
      ArrowLeft: [-26, 0], ArrowRight: [26, 0], ArrowUp: [0, -26], ArrowDown: [0, 26],
    };
    const onKey = (e) => {
      if (!nudges[e.key]) return;
      e.preventDefault();
      apply(...nudges[e.key]);
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("keydown", onKey);

    // ---------------------------------------------------------- framing
    // Fit from the model's real bounds, so it never crops and never floats in
    // a sea of empty frame at any panel size.
    const bounds = new THREE.Box3().setFromObject(rig);
    const centre = bounds.getCenter(new THREE.Vector3());
    const EYE = new THREE.Vector3(0.34, 0.42, 0.86).normalize();

    // The eight corners of the bounding box, relative to its centre. Fitting
    // against these exactly beats a bounding-sphere estimate, which for a wide
    // flat device leaves it marooned in the middle of the frame.
    const corners = [];
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          corners.push(new THREE.Vector3(x, y, z).sub(centre));
        }
      }
    }
    const right = new THREE.Vector3().crossVectors(EYE, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, EYE).normalize();

    const resize = () => {
      const { width, height: h } = el.getBoundingClientRect();
      if (!width || !h) return;
      renderer.setSize(width, h, false);
      camera.aspect = width / h;
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const tanV = Math.tan(vFov / 2);
      const tanH = Math.tan(hFov / 2);

      // For a corner at depth (D - p·eye), it fits when its sideways offset is
      // within tan(fov/2) * depth. Solve each for D and take the largest.
      let dist = 0;
      for (const p of corners) {
        const along = p.dot(EYE);
        dist = Math.max(
          dist,
          along + Math.abs(p.dot(right)) / tanH,
          along + Math.abs(p.dot(up)) / tanV,
        );
      }
      dist *= 1.04;   // a hair of breathing room

      camera.position.copy(EYE).multiplyScalar(dist).add(centre);
      camera.lookAt(centre);
      camera.updateProjectionMatrix();
      renderer.shadowMap.needsUpdate = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // ---------------------------------------------------------- loop
    const reduced = reducedMotion();
    const clock = new THREE.Clock();
    let raf;
    let visible = true;
    let acc = 0;
    const FRAME = 1 / 30;
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    io.observe(el);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (!visible || document.hidden) return;
      acc += dt;
      if (acc < FRAME) return;
      const step = acc;
      acc = 0;
      const v = live.current;

      // Smoothing window: how sluggishly the ball chases your hand.
      const chase = 1 - Math.pow(0.001, (step * 12) / Math.max(1, v.sma ?? 1));
      smoothed.lerp(vel, chase);
      vel.multiplyScalar(Math.pow(0.12, step));

      ball.rotation.x += smoothed.x;
      ball.rotation.y += smoothed.y;
      if (!reduced && !dragging) ball.rotation.y += step * 0.05;

      // Twist-scroll turns the encoder wheels, the way it would on the desk.
      wheelSpin *= Math.pow(0.02, step);
      for (const w of wheels) w.rotation.y += wheelSpin * step;

      deadFlash = Math.max(0, deadFlash - step * 2.4);
      deadRing.material.opacity = deadFlash * 0.9;

      const bright = v.glow ? (v.brightness ?? 60) / 100 : 0;
      glow.intensity = THREE.MathUtils.lerp(glow.intensity, bright * 26, 0.08);

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("keydown", onKey);
      for (const d of disposables) d.dispose?.();
      envRT.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [onScrollTick]);

  return (
    <div
      ref={host}
      className="ball"
      tabIndex={0}
      role="application"
      aria-label="Trackball preview. Drag it, or use the arrow keys, to spin the ball."
    />
  );
}
