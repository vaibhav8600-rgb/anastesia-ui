import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// A split keyboard, in three dimensions, built from what the board reported.
//
// The geometry is the reference model's — the sweep that finds a case outline
// around a staggered key field, the rounded extrusion, the keycap and stem
// shapes. What is not the reference model's is the key field itself. That was a
// hard-coded table of rows, which would have meant matching sixty positions in
// a table against sixty bindings arriving over the wire and hoping the two
// orders agreed. They are read from the physical layout instead, so key n in
// this scene is binding n by construction, and there is nothing to keep in
// step.
//
// Which is also why this is not Sofle-specific in anything but its name: it
// draws whatever shape the layout describes. The name is the gate because it is
// the one board this has been looked at on.

/** One key unit in millimetres. ZMK reports hundredths of a unit. */
const U = 19.05;
const mm = (v) => ((v ?? 0) / 100) * U;

const PLATE_Y = 9.5;    // switch plate surface
const CAP_BOT = 15;     // keycap underside
const CAP_H = 10.8;
const CASE_TOP = 13;    // top of the rim
const TRAVEL = 2.4;     // how far a cap drops when pressed

// Pose. A split board tented and splayed reads as two halves of one keyboard;
// laid flat it reads as a picture of a keyboard. Fixed rather than adjustable —
// this is a keymap editor, and the angles are here to make the shape legible,
// not to design a case.
const TENT = (10 * Math.PI) / 180;
const SPLAY = (8 * Math.PI) / 180;
const GAP = 70;

// Two palettes rather than the reference's four colourways, picked to sit under
// this app's own ground rather than to be chosen.
const DARK = {
  case: "#2F2B29", rim: "#3A3533", plate: "#171514",
  cap: "#4A433F", stem: "#141312", legend: "#F4EFE9",
};
const LIGHT = {
  case: "#F7F3EB", rim: "#EFE9DF", plate: "#DFD9CF",
  cap: "#F2EADF", stem: "#3A3633", legend: "#332C26",
};

/* ------------------------------------------------------------------ shapes */

function roundedRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Extrude upward and sit the result on y = 0, so pieces stack by position. */
function flatExtrude(shape, depth, bevel) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0,
    bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 10,
  });
  // +PI/2 maps the shape's +y onto world +z, which keeps front-to-back the same
  // sense as the layout's own y.
  g.rotateX(Math.PI / 2);
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);
  return g;
}

/** A part's four corners, grown by a margin. */
function rectPoly(p, m) {
  const hw = p.w / 2 + m, hh = p.h / 2 + m;
  const ca = Math.cos(p.rot), sa = Math.sin(p.rot);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
    .map(([qx, qy]) => [p.x + qx * ca + qy * sa, p.z - qx * sa + qy * ca]);
}

/** Where a vertical line at x enters and leaves a convex polygon. */
function spanAt(poly, x) {
  let lo = Infinity, hi = -Infinity, hit = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[0] <= x && b[0] >= x) || (b[0] <= x && a[0] >= x)) {
      hit = true;
      if (Math.abs(b[0] - a[0]) < 1e-9) {
        lo = Math.min(lo, a[1], b[1]); hi = Math.max(hi, a[1], b[1]);
      } else {
        const z = a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
        lo = Math.min(lo, z); hi = Math.max(hi, z);
      }
    }
  }
  return hit ? [lo, hi] : null;
}

/** Douglas-Peucker, so the stagger's steps stay crisp and diagonals stay straight. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], az = pts[a][1];
    const dx = pts[b][0] - ax, dz = pts[b][1] - az;
    const len = Math.hypot(dx, dz) || 1;
    let maxd = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len;
      if (d > maxd) { maxd = d; idx = i; }
    }
    if (maxd > tol && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * A case outline around a set of parts.
 *
 * Swept left to right, taking the nearest and furthest edge of everything the
 * case has to enclose at each step. That reproduces the column stagger as
 * steps and wraps a rotated thumb key as a wedge, without anyone having to
 * describe either.
 */
function outline(parts, m, step) {
  const polys = parts.map((p) => rectPoly(p, m));
  let xmin = Infinity, xmax = -Infinity;
  for (const p of polys) for (const v of p) {
    if (v[0] < xmin) xmin = v[0];
    if (v[0] > xmax) xmax = v[0];
  }
  const near = [], far = [];
  const n = Math.max(2, Math.ceil((xmax - xmin) / step));
  for (let i = 0; i <= n; i++) {
    const x = xmin + ((xmax - xmin) * i) / n;
    let lo = Infinity, hi = -Infinity;
    for (const poly of polys) {
      const iv = spanAt(poly, x);
      if (iv) { if (iv[0] < lo) lo = iv[0]; if (iv[1] > hi) hi = iv[1]; }
    }
    if (lo === Infinity) continue;
    near.push([x, lo]); far.push([x, hi]);
  }
  return simplify(near, 0.4).concat(simplify(far, 0.4).reverse());
}

/** Trace a polygon with rounded corners into a Shape or Path. */
function tracePolygon(target, poly, radius) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
    const v1x = cur[0] - prev[0], v1y = cur[1] - prev[1];
    const v2x = next[0] - cur[0], v2y = next[1] - cur[1];
    const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
    const r = Math.min(radius, l1 * 0.48, l2 * 0.48);
    const ax = cur[0] - (v1x / l1) * r, ay = cur[1] - (v1y / l1) * r;
    const bx = cur[0] + (v2x / l2) * r, by = cur[1] + (v2y / l2) * r;
    if (i === 0) target.moveTo(ax, ay); else target.lineTo(ax, ay);
    target.quadraticCurveTo(cur[0], cur[1], bx, by);
  }
  target.closePath();
  return target;
}

/* ------------------------------------------------------------------ layout */

/**
 * One key's centre and rotation in millimetres.
 *
 * ZMK turns a key about (rx, ry) rather than about itself, which is how a
 * thumb cluster is described — but proto3 leaves a zero out, so an absent
 * origin and an origin at the top-left corner of the board are the same bytes.
 * A zero origin is read as "about itself", which is what the flat board does
 * and what these layouts mean.
 */
function place(k) {
  const ang = ((k.r ?? 0) / 100) * (Math.PI / 180);
  let cx = (k.x ?? 0) + (k.width ?? 100) / 2;
  let cy = (k.y ?? 0) + (k.height ?? 100) / 2;
  if (ang && (k.rx || k.ry)) {
    const dx = cx - k.rx, dy = cy - k.ry;
    cx = k.rx + dx * Math.cos(ang) - dy * Math.sin(ang);
    cy = k.ry + dx * Math.sin(ang) + dy * Math.cos(ang);
  }
  return {
    x: mm(cx), z: mm(cy), rot: -ang,
    w: mm(k.width ?? 100), h: mm(k.height ?? 100),
  };
}

/**
 * Which keys belong to which half, from the widest empty column in the middle.
 *
 * A split board leaves a gap no key crosses; a one-piece board does not, and
 * gets a single half, which the pose code then leaves alone. Nothing here needs
 * to know how many columns a Sofle has.
 */
export function splitHalves(spots) {
  if (spots.length < 4) return [spots.map((_, i) => i)];
  const order = spots.map((s, i) => ({ i, x: s.x })).sort((a, b) => a.x - b.x);
  let best = 0, at = -1;
  for (let n = 1; n < order.length; n++) {
    const d = order[n].x - order[n - 1].x;
    if (d > best) { best = d; at = n; }
  }
  // One key unit of empty space is a stagger; three is a split. Below that,
  // treat the board as one piece rather than inventing a seam in it.
  if (best < U * 2.5 || at < 0) return [spots.map((_, i) => i)];
  return [order.slice(0, at).map((o) => o.i), order.slice(at).map((o) => o.i)];
}

/* ---------------------------------------------------------------- textures */

function labelCanvas(text, colour) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = colour;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const n = (text ?? "").length;
  const size = n > 7 ? 20 : n > 4 ? 26 : n > 1 ? 36 : 54;
  g.font = `600 ${size}px system-ui, sans-serif`;
  // Wrap once. A legend is a keycap legend, not a paragraph.
  if (n > 7 && text.includes(" ")) {
    const cut = text.lastIndexOf(" ", Math.ceil(n / 2) + 3);
    const i = cut > 0 ? cut : text.indexOf(" ");
    g.fillText(text.slice(0, i), 64, 50);
    g.fillText(text.slice(i + 1), 64, 50 + size * 1.15);
  } else {
    g.fillText(text ?? "", 64, 66);
  }
  return c;
}

/* --------------------------------------------------------------- component */

export default function Sofle({ keys, labels, active, onPick }) {
  const host = useRef(null);
  const api = useRef(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [supported, setSupported] = useState(true);

  // Both dependencies are compared by value. React hands a fresh array every
  // render, so depending on the arrays themselves would tear down and rebuild
  // sixty keycaps, their geometries and their textures on every keystroke into
  // the layer-name field.
  const shape = JSON.stringify(keys);
  const legendKey = JSON.stringify(labels);

  useEffect(() => {
    const el = host.current;
    if (!el || !keys?.length) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setSupported(false);
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    // Not PCFSoftShadowMap: three deprecates it and substitutes this anyway.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 1, 4000);

    const junk = [];
    const track = (x) => { junk.push(x); return x; };

    // The page decides whether this is a dark room or a lit one, and the key
    // type colours come from the same tokens the flat board and the legend use
    // — so a modifier is the same violet in both views or the legend is a lie.
    const css = getComputedStyle(document.documentElement);
    const bg = new THREE.Color(css.getPropertyValue("--bg").trim() || "#141828");
    const dark = bg.r * 0.299 + bg.g * 0.587 + bg.b * 0.114 < 0.5;
    const pal = dark ? DARK : LIGHT;
    const typeColour = (slug) => {
      const raw = css.getPropertyValue(`--kt-${slug}`).trim();
      if (!raw) return null;
      try { return new THREE.Color(raw); } catch { return null; }
    };

    scene.add(new THREE.HemisphereLight(0xfff4e8, dark ? 0x2a2530 : 0xb9b4c6, 1.05));
    const key = new THREE.DirectionalLight(0xfff3e2, 1.6);
    key.position.set(-190, 340, 240);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const D = 340;
    key.shadow.camera.left = -D; key.shadow.camera.right = D;
    key.shadow.camera.top = D; key.shadow.camera.bottom = -D;
    key.shadow.camera.near = 60; key.shadow.camera.far = 1000;
    key.shadow.bias = -0.0013;
    key.shadow.camera.updateProjectionMatrix();
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd6e4ff, 0.45);
    fill.position.set(260, 180, -200);
    scene.add(fill);

    const ground = new THREE.Mesh(
      track(new THREE.PlaneGeometry(2600, 2600)),
      track(new THREE.ShadowMaterial({ opacity: dark ? 0.3 : 0.16 })),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    scene.add(ground);

    const board = new THREE.Group();
    scene.add(board);

    // ------------------------------------------------------------- build
    const spots = keys.map(place);
    const groups = splitHalves(spots);

    // One geometry per distinct key size, not per key. A sixty-key board has
    // two or three sizes on it.
    const capGeo = new Map();
    const stemGeo = new Map();

    const stemMat = track(new THREE.MeshStandardMaterial({ color: pal.stem, roughness: 0.88 }));
    const caseMat = track(new THREE.MeshStandardMaterial({ color: pal.case, roughness: 0.68 }));
    const plateMat = track(new THREE.MeshStandardMaterial({ color: pal.plate, roughness: 0.8 }));
    const rimMat = track(new THREE.MeshStandardMaterial({ color: pal.rim, roughness: 0.74 }));

    const caps = [];      // one per key position, index-aligned with bindings
    const legends = [];
    const halves = [];

    for (const idx of groups) {
      const pivot = new THREE.Group();
      const g = new THREE.Group();
      pivot.add(g);
      const parts = [];

      for (const position of idx) {
        const s = spots[position];
        const info = labels?.[position] ?? {};
        parts.push(s);

        const ck = `${s.w.toFixed(1)}x${s.h.toFixed(1)}`;
        if (!capGeo.has(ck)) {
          capGeo.set(ck, track(flatExtrude(roundedRect(s.w - 3.4, s.h - 3.4, 2.0), CAP_H - 2.8, 1.4)));
        }
        if (!stemGeo.has(ck)) {
          const t = CAP_BOT - PLATE_Y + 0.6;
          const box = track(new THREE.BoxGeometry(Math.max(2, s.w - 4.6), t, Math.max(2, s.h - 4.6)));
          box.translate(0, t / 2, 0);
          stemGeo.set(ck, box);
        }

        const base = new THREE.Color(pal.cap);
        const tint = typeColour(info.type);
        // Letters are left alone here for the same reason they are on the flat
        // board: they are most of a keyboard, and a board where every cap is
        // coloured is a board where the colour says nothing.
        const colour = tint && !["letter", "none", "other"].includes(info.type)
          ? base.clone().lerp(tint, dark ? 0.42 : 0.3)
          : base;

        const mat = track(new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6 }));
        const cap = new THREE.Mesh(capGeo.get(ck), mat);
        cap.position.set(s.x, CAP_BOT, s.z);
        cap.rotation.y = s.rot;
        cap.castShadow = true;
        cap.receiveShadow = true;
        cap.userData = { position, base: colour.clone() };
        g.add(cap);
        caps[position] = cap;

        const stem = new THREE.Mesh(stemGeo.get(ck), stemMat);
        stem.position.set(s.x, PLATE_Y - 0.3, s.z);
        stem.rotation.y = s.rot;
        g.add(stem);

        const tex = track(new THREE.CanvasTexture(labelCanvas(info.cap, pal.legend)));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        const lg = track(new THREE.PlaneGeometry(Math.min(s.w, s.h) * 0.74, Math.min(s.w, s.h) * 0.74));
        lg.rotateX(-Math.PI / 2);
        const legend = new THREE.Mesh(lg, track(new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false,
        })));
        legend.position.set(s.x, CAP_BOT + CAP_H + 0.06, s.z);
        legend.rotation.y = s.rot;
        g.add(legend);
        legends[position] = legend;
      }

      // Stacked bottom up: a baseplate proud of the walls, walls with the key
      // field cut through them, then the switch plate the caps sit on.
      const bottom = new THREE.Mesh(
        track(flatExtrude(tracePolygon(new THREE.Shape(), outline(parts, 6.5, 0.6), 7.0), 2.2, 0.4)),
        rimMat,
      );
      bottom.castShadow = true; bottom.receiveShadow = true;
      g.add(bottom);

      const caseShape = tracePolygon(new THREE.Shape(), outline(parts, 4.0, 0.6), 6.5);
      caseShape.holes.push(tracePolygon(new THREE.Path(), outline(parts, 1.2, 0.6).reverse(), 4.0));
      const walls = new THREE.Mesh(track(flatExtrude(caseShape, CASE_TOP - 3.0 - 1.2, 0.6)), caseMat);
      walls.position.y = 3.0;
      walls.castShadow = true; walls.receiveShadow = true;
      g.add(walls);

      const plate = new THREE.Mesh(
        track(flatExtrude(tracePolygon(new THREE.Shape(), outline(parts, 2.4, 0.6), 4.5), 2, 0)),
        plateMat,
      );
      plate.position.y = PLATE_Y - 2;
      plate.receiveShadow = true;
      g.add(plate);

      const box = new THREE.Box3().setFromObject(g);
      g.position.x = -(box.min.x + box.max.x) / 2;
      g.position.z = -(box.min.z + box.max.z) / 2;

      board.add(pivot);
      halves.push({ pivot, width: (box.max.x - box.min.x) / 2 });
    }

    // Tent and splay each half about its own inner edge, then sit the lowest
    // corner on the desk. One half means a one-piece board: leave it flat.
    halves.forEach((h, i) => {
      const m = halves.length === 1 ? 0 : (i === 0 ? 1 : -1);
      h.pivot.rotation.set(0, SPLAY * m, TENT * m);
      h.pivot.position.set(-(GAP / 2 + h.width) * m, 0, 0);
      const b = new THREE.Box3().setFromObject(h.pivot);
      h.pivot.position.y = -b.min.y;
    });

    const span = new THREE.Box3().setFromObject(board);
    const focus = span.getCenter(new THREE.Vector3());
    const corners = [];
    for (const x of [span.min.x, span.max.x])
      for (const y of [span.min.y, span.max.y])
        for (const z of [span.min.z, span.max.z]) corners.push(new THREE.Vector3(x, y, z));

    // ------------------------------------------------------------ camera
    /**
     * How far back to stand so the whole board is in frame.
     *
     * The box is projected onto the view plane and each axis is fitted to its
     * own field of view. A bounding sphere fitted to the tighter of the two
     * fields — which is the obvious version — is badly wrong for this shape: a
     * keyboard seen from above is wide and shallow, so the sphere is sized by a
     * width that the horizontal field has room to spare for, and then that
     * width is fitted into the vertical one. It put the board on screen at
     * about a third of the size it should have been.
     */
    const fit = (pad = 1.06) => {
      const dir = new THREE.Vector3(
        Math.sin(cam.phi) * Math.cos(cam.theta),
        Math.cos(cam.phi),
        Math.sin(cam.phi) * Math.sin(cam.theta),
      );
      const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
      // Straight down, the view direction and world up are the same line and
      // the cross product is nothing. Any horizontal vector will do there.
      if (right.lengthSq() < 1e-8) right.set(Math.sin(cam.theta), 0, -Math.cos(cam.theta));
      right.normalize();
      const up = new THREE.Vector3().crossVectors(right, dir).normalize();
      let hx = 0, hy = 0;
      for (const c of corners) {
        const v = c.clone().sub(focus);
        hx = Math.max(hx, Math.abs(v.dot(right)));
        hy = Math.max(hy, Math.abs(v.dot(up)));
      }
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1));
      return Math.max(hx / Math.tan(hFov / 2), hy / Math.tan(vFov / 2)) * pad;
    };
    const cam = { theta: Math.PI / 2 + 0.3, phi: 0.78, dist: 0, target: focus.clone() };
    cam.dist = fit();
    const place3 = () => {
      cam.phi = Math.max(0.06, Math.min(Math.PI / 2 - 0.02, cam.phi));
      cam.dist = Math.max(120, Math.min(2000, cam.dist));
      camera.position.set(
        cam.target.x + cam.dist * Math.sin(cam.phi) * Math.cos(cam.theta),
        cam.target.y + cam.dist * Math.cos(cam.phi),
        cam.target.z + cam.dist * Math.sin(cam.phi) * Math.sin(cam.theta),
      );
      camera.lookAt(cam.target);
    };

    // ------------------------------------------------------------- input
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let drag = null, lastX = 0, lastY = 0, moved = 0, touched = false;

    const onDown = (e) => {
      drag = e.button === 2 || e.shiftKey ? "pan" : "orbit";
      lastX = e.clientX; lastY = e.clientY; moved = 0;
      // Throws when the pointer is not actually down on this element, which a
      // synthetic event is not. Capture is a nicety; losing it is not a reason
      // to lose the drag.
      try { el.setPointerCapture(e.pointerId); } catch { /* not captured */ }
    };
    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      touched = true;
      if (drag === "orbit") {
        cam.theta -= dx * 0.006;
        cam.phi -= dy * 0.006;
      } else {
        const s = cam.dist * 0.0016;
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        cam.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
      }
      place3();
    };
    const onUp = (e) => {
      // A drag that went nowhere is a click. Anything further is a look around,
      // and must not also rebind whatever was under the cursor when it started.
      if (drag === "orbit" && moved < 5) {
        const r = el.getBoundingClientRect();
        pointer.set(((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(pointer, camera);
        const hit = ray.intersectObjects(caps.filter(Boolean), false)[0];
        if (hit) pick.current?.(hit.object.userData.position);
      }
      drag = null;
    };
    const onWheel = (e) => {
      e.preventDefault();
      touched = true;
      cam.dist *= 1 + Math.sign(e.deltaY) * 0.09;
      place3();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", () => { drag = null; });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", onWheel, { passive: false });

    // ------------------------------------------------------------ resize
    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      // Only refit while the view is untouched. Resizing after someone has
      // zoomed in on a thumb cluster should not throw their view away.
      if (!touched) cam.dist = fit();
      place3();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // --------------------------------------------------------------- api
    const press = new Float32Array(caps.length);
    const target = new Float32Array(caps.length);
    api.current = {
      highlight(position) {
        caps.forEach((cap, i) => {
          if (!cap) return;
          const on = i === position;
          cap.material.color.copy(cap.userData.base);
          if (on) cap.material.color.lerp(new THREE.Color(0xffffff), dark ? 0.36 : 0.22);
          cap.material.emissive.setHex(on ? 0x2a2438 : 0x000000);
        });
      },
      tap(position) {
        if (caps[position]) {
          target[position] = 1;
          setTimeout(() => { target[position] = 0; }, 140);
        }
      },
      view(name) {
        if (name === "top") { cam.theta = Math.PI / 2; cam.phi = 0.07; }
        else if (name === "front") { cam.theta = Math.PI / 2; cam.phi = 1.32; }
        else { cam.theta = Math.PI / 2 + 0.3; cam.phi = 0.78; }
        cam.dist = fit();
        cam.target.copy(focus);
        touched = false;
        place3();
      },
    };

    // -------------------------------------------------------------- loop
    const timer = new THREE.Timer();
    let raf, visible = true;
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    io.observe(el);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      timer.update();
      const dt = Math.min(timer.getDelta(), 0.05);
      if (!visible || document.hidden) return;
      const k = Math.min(1, dt * 22);
      for (let i = 0; i < caps.length; i++) {
        if (!caps[i]) continue;
        const a = press[i] + (target[i] - press[i]) * k;
        if (Math.abs(a - press[i]) < 0.0004 && a < 0.0004) continue;
        press[i] = a;
        caps[i].position.y = CAP_BOT - a * TRAVEL;
        legends[i].position.y = CAP_BOT + CAP_H + 0.06 - a * TRAVEL;
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
      api.current = null;
      for (const d of junk) d.dispose?.();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [shape, legendKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { api.current?.highlight(active ?? -1); }, [active]);

  if (!supported) {
    return (
      <p className="ctl__hint">
        This browser has no WebGL, so the board cannot be drawn in three
        dimensions. The flat view has everything this one does.
      </p>
    );
  }

  return (
    <div className="board3d">
      <div className="board3d__view" ref={host} tabIndex={0} role="application"
           aria-label="The board in three dimensions. Click a key to edit it." />
      <div className="board3d__views">
        <button className="zoom__btn" onClick={() => api.current?.view("iso")}>Iso</button>
        <button className="zoom__btn" onClick={() => api.current?.view("top")}>Top</button>
        <button className="zoom__btn" onClick={() => api.current?.view("front")}>Front</button>
      </div>
    </div>
  );
}
