import { useEffect, useRef } from "react";
import * as THREE from "three";

// The ball is the preview: every knob you turn changes how it behaves under
// your finger, so "sensitivity 4x" is something you feel before you save it.

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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    // Distance is derived from the frame's aspect in resize(), so the ball
    // fills a phone strip and a desktop square equally well.
    // The rig is wider than it is tall (the rings lie flat), so each axis gets
    // its own radius — one number would waste half the frame.
    const FIT_V = 1.5;    // ball top down to the socket
    const FIT_H = 1.85;   // outermost ring
    const EYE = new THREE.Vector3(0, 0.25, 0.97).normalize();
    const TARGET = new THREE.Vector3(0, -0.08, 0);

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1.35, 64, 48),
      new THREE.MeshStandardMaterial({ color: 0x5a66a8, roughness: 0.42, metalness: 0.22 }),
    );
    // Speckle, otherwise a plain sphere spins invisibly.
    const speckle = speckleTexture();
    ball.material.map = speckle;
    ball.material.roughnessMap = speckle;
    scene.add(ball);

    const rig = new THREE.Group();
    scene.add(rig);

    const socket = new THREE.Mesh(
      new THREE.TorusGeometry(1.44, 0.09, 20, 96),
      new THREE.MeshStandardMaterial({ color: 0x333a55, roughness: 0.55 }),
    );
    socket.rotation.x = Math.PI / 2;
    socket.position.y = -0.6;
    rig.add(socket);

    // Flares when the dead zone swallows a movement.
    const deadRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.74, 0.022, 12, 96),
      new THREE.MeshBasicMaterial({ color: 0xffa06a, transparent: true, opacity: 0 }),
    );
    deadRing.rotation.x = Math.PI / 2;
    deadRing.position.y = -0.6;
    rig.add(deadRing);

    // Sweeps once per twist-scroll step.
    const twistRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.6, 0.038, 12, 96, Math.PI * 0.55),
      new THREE.MeshBasicMaterial({ color: 0x7cd4ff, transparent: true, opacity: 0 }),
    );
    twistRing.rotation.x = Math.PI / 2;
    twistRing.position.y = -0.6;
    rig.add(twistRing);

    scene.add(new THREE.HemisphereLight(0xa9bcff, 0x141a2e, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(2.6, 3.4, 3.2);
    scene.add(key);
    // Rim light picks the silhouette off the dark panel behind it.
    const rim = new THREE.DirectionalLight(0x7cd4ff, 2.2);
    rim.position.set(-3, 1.2, -2.4);
    scene.add(rim);
    const glow = new THREE.PointLight(0x7cd4ff, 0, 7);
    glow.position.set(0, -1, 0);
    scene.add(glow);

    const vel = new THREE.Vector2();
    const smoothed = new THREE.Vector2();
    let dragging = false;
    let last = null;
    let deadFlash = 0;
    let twistFlash = 0;
    let twistAcc = 0;

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

      const gain = 0.0009 * (v.sens ?? 1);
      vel.x += ry * gain;
      vel.y += rx * gain;

      if (v.twist) {
        twistAcc += Math.abs(rx) * (v.twistSens ?? 1);
        if (twistAcc > 60) {
          twistAcc = 0;
          twistFlash = 1;
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

    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;

      // Fit the sphere to whichever axis is tighter, so it never crops and
      // never floats in a sea of empty frame.
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const dist = 1.05 * Math.max(FIT_V / Math.sin(vFov / 2), FIT_H / Math.sin(hFov / 2));
      camera.position.copy(EYE).multiplyScalar(dist);
      camera.lookAt(TARGET);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const reduced = reducedMotion();
    const clock = new THREE.Clock();
    let raf;
    let visible = true;
    let acc = 0;
    // A trackball does not need 60fps, and on software renderers each frame
    // costs enough to stall the rest of the UI. 30 is plenty and halves it.
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
      if (!reduced && !dragging) ball.rotation.y += step * 0.06;

      rig.rotation.y = THREE.MathUtils.lerp(rig.rotation.y, ((v.plane ?? 0) * Math.PI) / 180 * 0.35, 0.1);

      deadFlash = Math.max(0, deadFlash - step * 2.4);
      deadRing.material.opacity = deadFlash * 0.85;
      deadRing.scale.setScalar(1 + (1 - deadFlash) * 0.05);

      twistFlash = Math.max(0, twistFlash - step * 1.8);
      twistRing.material.opacity = twistFlash * 0.9;
      twistRing.rotation.z += step * 2.6;

      const bright = v.glow ? (v.brightness ?? 60) / 100 : 0;
      glow.intensity = THREE.MathUtils.lerp(glow.intensity, bright * 5, 0.08);

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
      scene.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      speckle.dispose();
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
      aria-label="Trackball preview. Drag it, or use the arrow keys, to spin it."
    />
  );
}

/** Procedural speckle so rotation reads without shipping a texture file. */
function speckleTexture() {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = "#4a5490";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 3400; i++) {
    const light = Math.random() > 0.45;
    g.fillStyle = light
      ? `rgba(206,222,255,${Math.random() * 0.55 + 0.12})`
      : `rgba(18,22,44,${Math.random() * 0.45 + 0.1})`;
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, Math.random() * 3 + 0.6, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  return t;
}
