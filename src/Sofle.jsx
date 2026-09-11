import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { encoderKeys, splitHalves } from "./studio.js";
import { drawGlyph } from "./glyphs.js";

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

/** One key unit in millimetres. ZMK reports hundredths of a unit. */
const U = 19.05;
const mm = (v) => ((v ?? 0) / 100) * U;

const PLATE_Y = 9.5;    // switch plate surface
const CAP_BOT = 15;     // keycap underside
const CAP_H = 10.8;
const CASE_TOP = 13;    // top of the rim
const TRAVEL = 2.4;     // how far a cap drops when pressed
// The gap between one keycap and the next, in millimetres. A real MX cap is
// 18mm on 19.05 spacing, so a quarter of this — but a board drawn at 400
// pixels wide needs the separation to survive being small, and the plate
// showing through is what makes the caps read as separate objects.
const CAP_GAP = 4.0;

// nice!view: LS011B7DH03, 1.08 inch, 160x68, module 36 x 14 x 2.9 mm, mounted
// with its long axis running front to back so the panel is portrait.
const DISPLAY = { w: 14, h: 36, aw: 11.7, ah: 27.5, t: 2.9, inset: 21 };
// How far toward the top of the board the nice!view sits from its encoder. The
// reference put the module at z 12 and the knob at 48, and the module is the
// one of the pair that is not a key, so it is the one measured from the other.
const DISPLAY_AHEAD = 36;
// And 3.2mm further inboard than the knob — the reference's 21 against 17.8.
// Small, but it is what puts the two in one lobe of the case instead of two.
const DISPLAY_ASIDE = 3.2;
const ENCODER = { r: 8.0 };

const THEMES = {
  ink: {
    name: "Ink & ember", case: "#2F2B29", rim: "#3A3533", plate: "#171514",
    outer: "#E0704B", inner: "#4E4744", legend: "#F2ECE5", accent: "#E0704B",
    lcd: "#BFC5BB", lcdInk: "#12160F", stem: "#141312", bezel: "#3A3533",
  },
  peach: {
    name: "Peach & cream", case: "#F7F3EB", rim: "#F2EDE4", plate: "#E4DFD6",
    outer: "#F2A48D", inner: "#F8EAD9", legend: "#C2664B", accent: "#F2A48D",
    lcd: "#D7DDD2", lcdInk: "#141A15", stem: "#3A3633", bezel: "#FBF8F3",
  },
  milktea: {
    name: "Milk tea", case: "#EFE7DC", rim: "#E9DFD2", plate: "#DDD2C3",
    outer: "#BC9370", inner: "#EDDFCB", legend: "#5A4433", accent: "#BC9370",
    lcd: "#D7DDD2", lcdInk: "#141A15", stem: "#3A3633", bezel: "#F6F0E7",
  },
  matcha: {
    name: "Matcha", case: "#F1F3EE", rim: "#E7EBE2", plate: "#DCE2D5",
    outer: "#8FAF87", inner: "#EAF0E3", legend: "#3D573A", accent: "#8FAF87",
    lcd: "#D7DDD2", lcdInk: "#141A15", stem: "#3A3633", bezel: "#F7F9F4",
  },
};

const SETTINGS_KEY = "anastasia-board-3d";
const DEFAULTS = {
  theme: "ink", tint: "type", tent: 10, splay: 8, gap: 70, disp: 21,
  legends: true, cases: true, screens: true, shadows: true,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    // Merged rather than trusted: a stored blob from an older build is missing
    // whatever was added since, and a missing toggle reads as "off".
    return { ...DEFAULTS, ...saved, theme: THEMES[saved.theme] ? saved.theme : DEFAULTS.theme };
  } catch { return { ...DEFAULTS }; }
}

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
 * origin and an origin at the very corner of the board are the same bytes. A
 * zero origin is read as "about itself", which is what the flat board does and
 * what these layouts mean.
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

/* ---------------------------------------------------------------- textures */

function labelCanvas(text, colour, icon) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = colour;
  g.textAlign = "center";
  g.textBaseline = "middle";

  // An icon takes the middle of the cap and the text drops under it — the same
  // order the flat board uses, drawn from the same path data.
  if (icon && drawGlyph(g, icon, 64, text ? 46 : 64, text ? 54 : 70, colour, 2.2)) {
    if (text) {
      // Sized to what is there rather than cut to five characters — "Middle"
      // came out as "Middl", which is not a shorter word for anything.
      const px = text.length > 7 ? 17 : text.length > 5 ? 21 : 27;
      g.font = `600 ${px}px system-ui, sans-serif`;
      g.fillText(text, 64, 102);
    }
    return c;
  }

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

// The panel is 11.7mm across, which is very few screen pixels, and mipmapping
// averages hairline strokes straight into the background until the display
// reads as blank. Drawn at 4x and minified with a plain linear filter.
const SS = 4;

/**
 * What the displays show.
 *
 * The reference painted battery, Bluetooth profiles and a words-per-minute
 * graph. None of that is knowable here: ZMK Studio's RPC carries a keymap and
 * nothing else, so a battery reading on this screen would be a drawing of a
 * battery reading. It shows what the editor actually knows — which board, which
 * layer, and how many there are.
 */
function paintScreen(ctx, theme, info, side) {
  const th = THEMES[theme], W = 68, H = 160;
  ctx.setTransform(SS, 0, 0, SS, 0, 0);
  ctx.fillStyle = th.lcd; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = th.lcdInk; ctx.strokeStyle = th.lcdInk; ctx.lineWidth = 1.6;
  ctx.textAlign = "left";

  ctx.font = '500 8px system-ui, sans-serif';
  ctx.fillText((info.device ?? "ZMK").slice(0, 12), 5, 13);
  ctx.beginPath(); ctx.moveTo(5, 19); ctx.lineTo(W - 5, 19); ctx.stroke();

  if (side === 0) {
    ctx.font = '500 8px system-ui, sans-serif';
    ctx.fillText("LAYER", 5, 34);
    const name = (info.layer ?? "").slice(0, 9) || `L${info.index ?? 0}`;
    ctx.font = `700 ${name.length > 6 ? 12 : 15}px system-ui, sans-serif`;
    ctx.fillText(name, 5, 52);
    // One box per layer, the current one filled. Real, and it is the thing you
    // most want to see from across the desk.
    for (let i = 0; i < Math.min(info.layers ?? 1, 6); i++) {
      if (i === info.index) ctx.fillRect(5 + i * 10, 64, 7, 7);
      else ctx.strokeRect(5.5 + i * 10, 64.5, 6, 6);
    }
  } else {
    ctx.font = '500 8px system-ui, sans-serif';
    ctx.fillText("KEYS", 5, 34);
    ctx.font = '700 20px system-ui, sans-serif';
    ctx.fillText(String(info.keys ?? 0), 5, 55);
    ctx.font = '500 8px system-ui, sans-serif';
    ctx.fillText(info.dirty ? "unsaved" : "saved", 5, 72);
  }
}

/* --------------------------------------------------------------- component */

export default function Sofle({ keys, labels, active, onPick, info, detail }) {
  const host = useRef(null);
  const api = useRef(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [supported, setSupported] = useState(true);
  const [set, setSet] = useState(loadSettings);
  // Which key the pointer is over, and where on screen to put the card. The
  // flat board has had this since it had keycaps; the model was the view where
  // you could see the whole keymap and not read any of it.
  const [hover, setHover] = useState(null);
  // Where the card sits, written straight to the element as the pointer moves.
  // Holding the position in state re-rendered this whole component on every
  // mouse move — and restringified the layout, the labels and the display
  // info to decide nothing had changed. State now changes only when the key
  // under the pointer does.
  const card = useRef(null);
  const hoverAt = useRef({ x: 0, y: 0 });
  const live = useRef(set);
  live.current = set;

  // Both dependencies are compared by value. React hands a fresh array every
  // render, so depending on the arrays themselves would tear down and rebuild
  // sixty keycaps, their geometries and their textures on every keystroke into
  // the layer-name field.
  const shape = JSON.stringify(keys);
  const legendKey = JSON.stringify(labels);
  const screenKey = JSON.stringify(info ?? null);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(set)); } catch { /* blocked */ }
  }, [set]);

  useEffect(() => {
    const el = host.current;
    if (!el || !keys?.length) return undefined;

    let renderer;
    try {
      // No preserveDrawingBuffer. It kept every frame's buffer alive for the
      // one moment "Save a PNG" needs it, and on many GPUs that is a copy per
      // frame. png() renders and reads back in the same task instead, before
      // the browser has had a chance to clear anything.
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
    // The light never moves and neither does the board unless a slider moves
    // it, so the shadow map is drawn once and redrawn only when the pose, the
    // display or what is visible changes. Orbiting is the camera moving, which
    // shadows do not care about. Before this it was a second full render of
    // every shadow-casting mesh, every frame.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    el.appendChild(renderer.domElement);

    // Drawn on demand, the same way as the trackball. See there for the why;
    // the short version is that a still board used to cost as much as a moving
    // one. `ready` holds wake() off until tick exists.
    let raf = 0, ready = false;
    const wake = () => { if (ready && !raf) raf = requestAnimationFrame(tick); };
    const reshadow = () => { renderer.shadowMap.needsUpdate = true; wake(); };

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 1, 4000);

    const junk = [];
    const track = (x) => { junk.push(x); return x; };

    const css = getComputedStyle(document.documentElement);
    const bg = new THREE.Color(css.getPropertyValue("--bg").trim() || "#141828");
    const dark = bg.r * 0.299 + bg.g * 0.587 + bg.b * 0.114 < 0.5;
    // Key type colours come from the same tokens the flat board and the legend
    // use, so a modifier is the same violet in both views or the legend lies.
    const typeColour = (slug) => {
      const raw = css.getPropertyValue(`--kt-${slug}`).trim();
      if (!raw) return null;
      try { return new THREE.Color(raw); } catch { return null; }
    };

    scene.add(new THREE.HemisphereLight(0xfff4e8, dark ? 0x2a2530 : 0xb9b4c6, 1.0));
    const keyLight = new THREE.DirectionalLight(0xfff3e2, 1.5);
    keyLight.position.set(-190, 340, 240);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    const D = 340;
    keyLight.shadow.camera.left = -D; keyLight.shadow.camera.right = D;
    keyLight.shadow.camera.top = D; keyLight.shadow.camera.bottom = -D;
    keyLight.shadow.camera.near = 60; keyLight.shadow.camera.far = 1000;
    keyLight.shadow.bias = -0.0013;
    keyLight.shadow.camera.updateProjectionMatrix();
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xd6e4ff, 0.42);
    fillLight.position.set(260, 180, -200);
    scene.add(fillLight);

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
    // An encoder's push is a switch, so it arrives as a key position like any
    // other. It gets a knob instead of a keycap rather than as well as one.
    // The halves say which way "inboard" is, which is how it is found.
    const knobAt = encoderKeys(spots, groups);
    const th0 = THEMES[live.current.theme];

    const capGeo = new Map();   // one geometry per distinct key size, not per key
    const stemGeo = new Map();

    const mats = {
      stem: track(new THREE.MeshStandardMaterial({ color: th0.stem, roughness: 0.88 })),
      case: track(new THREE.MeshStandardMaterial({ color: th0.case, roughness: 0.68, metalness: 0.02 })),
      plate: track(new THREE.MeshStandardMaterial({ color: th0.plate, roughness: 0.8 })),
      rim: track(new THREE.MeshStandardMaterial({ color: th0.rim, roughness: 0.74 })),
      bezel: track(new THREE.MeshStandardMaterial({ color: th0.bezel, roughness: 0.5 })),
      dot: track(new THREE.MeshStandardMaterial({ color: th0.accent, roughness: 0.5 })),
    };

    const caps = [];       // index-aligned with bindings
    const knobs = [];      // likewise, and never both at one position
    const legends = [];
    const capMeta = [];    // { type, ramp } for recolouring without a rebuild
    const halves = [];
    const screens = [];
    const screenAnchor = [];   // the nice!views, so the inset slider can move them
    const shells = [];     // everything the "Case" toggle hides

    groups.forEach((idx, side) => {
      const pivot = new THREE.Group();
      const g = new THREE.Group();
      pivot.add(g);
      const parts = [];

      // Where a key sits across its own half, for the gradient colouring. The
      // outer edge is the little finger's; for the right half that is +x.
      const xs = idx.map((p) => spots[p].x);
      const lo = Math.min(...xs), hi = Math.max(...xs);
      const rampOf = (x) => (hi - lo < 1e-6 ? 0 : (side === 0 ? x - lo : hi - x) / (hi - lo));

      for (const position of idx) {
        const s = spots[position];
        const info2 = labels?.[position] ?? {};
        parts.push(s);

        const ck = `${s.w.toFixed(1)}x${s.h.toFixed(1)}`;
        if (!capGeo.has(ck)) {
          capGeo.set(ck, track(flatExtrude(
            roundedRect(s.w - CAP_GAP, s.h - CAP_GAP, 2.0), CAP_H - 2.8, 1.4)));
        }
        if (!stemGeo.has(ck)) {
          const t = CAP_BOT - PLATE_Y + 0.6;
          // The stem has to stay inside the cap above it, whatever the gap is.
          const box = track(new THREE.BoxGeometry(
            Math.max(2, s.w - CAP_GAP - 1.4), t, Math.max(2, s.h - CAP_GAP - 1.4)));
          box.translate(0, t / 2, 0);
          stemGeo.set(ck, box);
        }

        if (knobAt.has(position)) {
          // A knob, at the position the board reported. Clicking it edits the
          // push binding, which is what that key position is.
          const body = new THREE.Mesh(
            track(new THREE.CylinderGeometry(ENCODER.r, ENCODER.r * 0.97, 10.5, 40)),
            track(new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.06 })),
          );
          body.position.y = 5.25;
          body.castShadow = true;
          const knob = new THREE.Group();
          knob.add(body);
          const ribGeo = track(new THREE.BoxGeometry(0.85, 8.6, 1.5));
          for (let i = 0; i < 20; i++) {
            const a = (i / 20) * Math.PI * 2;
            const rib = new THREE.Mesh(ribGeo, body.material);
            rib.position.set(Math.cos(a) * ENCODER.r, 5.25, Math.sin(a) * ENCODER.r);
            rib.rotation.y = -a;
            knob.add(rib);
          }
          const nub = new THREE.Mesh(track(new THREE.CylinderGeometry(1.1, 1.1, 0.6, 12)), mats.dot);
          nub.position.set(0, 10.7, ENCODER.r * 0.55);
          knob.add(nub);
          knob.position.set(s.x, PLATE_Y + 2.4, s.z);
          knob.userData = { position, isKnob: true };
          g.add(knob);
          shells.push(knob);

          const collar = new THREE.Mesh(
            track(new THREE.CylinderGeometry(ENCODER.r + 0.3, ENCODER.r + 0.6, 2.4, 30)), mats.bezel,
          );
          collar.position.set(s.x, PLATE_Y + 1.2, s.z);
          collar.receiveShadow = true;
          g.add(collar);
          shells.push(collar);

          knobs[position] = { group: knob, body, spin: 0, spinTo: 0, base: null };
          capMeta[position] = { type: info2.type, ramp: rampOf(s.x), knob: true };
          continue;
        }

        const mat = track(new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.02 }));
        const cap = new THREE.Mesh(capGeo.get(ck), mat);
        cap.position.set(s.x, CAP_BOT, s.z);
        cap.rotation.y = s.rot;
        cap.castShadow = true;
        cap.receiveShadow = true;
        cap.userData = { position };
        g.add(cap);
        caps[position] = cap;
        capMeta[position] = { type: info2.type, ramp: rampOf(s.x) };

        const stem = new THREE.Mesh(stemGeo.get(ck), mats.stem);
        stem.position.set(s.x, PLATE_Y - 0.3, s.z);
        stem.rotation.y = s.rot;
        g.add(stem);

        const tex = track(new THREE.CanvasTexture(labelCanvas(info2.cap, th0.legend, info2.icon)));
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
        legends[position] = { mesh: legend, text: info2.cap, icon: info2.icon };
      }

      // The inner edge of this half — where a Sofle puts its display and its
      // encoder. Derived from the key field rather than from a constant,
      // because the key field is the only thing here that was measured.
      const zs = idx.map((p) => spots[p].z);
      const zTop = Math.min(...zs);
      const innerSign = groups.length === 1 ? 0 : (side === 0 ? 1 : -1);
      const innerX = side === 0 ? hi : lo;

      // The nice!view is the one module here that is not a key, so it is the
      // only thing still placed rather than reported — measured off this half's
      // own encoder where there is one, and off the inner edge where there is
      // not.
      const mine = idx.filter((p) => knobAt.has(p));
      const anchor = mine.length ? spots[mine[0]] : null;
      let screen = null;
      if (innerSign || anchor) {
        const sign = innerSign || 1;
        const bezelBevel = 0.5, bezelH = DISPLAY.t + bezelBevel * 2;
        const bezel = new THREE.Mesh(
          track(flatExtrude(roundedRect(DISPLAY.w + 3.5, DISPLAY.h + 3.5, 2), DISPLAY.t, bezelBevel)),
          mats.bezel,
        );
        const sx = anchor ? anchor.x + sign * DISPLAY_ASIDE : innerX + sign * live.current.disp;
        const sz = anchor ? anchor.z - DISPLAY_AHEAD : zTop + 12;
        bezel.position.set(sx, PLATE_Y, sz);
        bezel.castShadow = true; bezel.receiveShadow = true;
        g.add(bezel);
        shells.push(bezel);
        screenAnchor.push({ bezel, sx, sz });
        parts.push({ x: sx, z: sz, rot: 0, w: DISPLAY.w + 4, h: DISPLAY.h + 4 });

        const c = document.createElement("canvas");
        c.width = 68 * SS; c.height = 160 * SS;
        const tex = track(new THREE.CanvasTexture(c));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.anisotropy = 8;
        const sg = track(new THREE.PlaneGeometry(DISPLAY.aw, DISPLAY.ah));
        sg.rotateX(-Math.PI / 2);
        screen = new THREE.Mesh(sg, track(new THREE.MeshBasicMaterial({ map: tex })));
        screen.position.set(sx, PLATE_Y + bezelH + 0.06, sz);
        g.add(screen);
        screens.push({ mesh: screen, ctx: c.getContext("2d"), tex, side });
        screenAnchor[screenAnchor.length - 1].screen = screen;
        screenAnchor[screenAnchor.length - 1].home = sx;
        screenAnchor[screenAnchor.length - 1].fixed = !!anchor;
        screenAnchor[screenAnchor.length - 1].sign = sign;

      }

      // Stacked bottom up: a baseplate proud of the walls, walls with the key
      // field cut through them, then the switch plate the caps sit on.
      const bottom = new THREE.Mesh(
        track(flatExtrude(tracePolygon(new THREE.Shape(), outline(parts, 6.5, 0.6), 7.0), 2.2, 0.4)),
        mats.rim,
      );
      bottom.castShadow = true; bottom.receiveShadow = true;
      g.add(bottom);

      const caseShape = tracePolygon(new THREE.Shape(), outline(parts, 4.0, 0.6), 6.5);
      caseShape.holes.push(tracePolygon(new THREE.Path(), outline(parts, 1.2, 0.6).reverse(), 4.0));
      const walls = new THREE.Mesh(track(flatExtrude(caseShape, CASE_TOP - 3.0 - 1.2, 0.6)), mats.case);
      walls.position.y = 3.0;
      walls.castShadow = true; walls.receiveShadow = true;
      g.add(walls);

      const plate = new THREE.Mesh(
        track(flatExtrude(tracePolygon(new THREE.Shape(), outline(parts, 2.4, 0.6), 4.5), 2, 0)),
        mats.plate,
      );
      plate.position.y = PLATE_Y - 2;
      plate.receiveShadow = true;
      g.add(plate);
      shells.push(bottom, walls, plate);

      const box = new THREE.Box3().setFromObject(g);
      g.position.x = -(box.min.x + box.max.x) / 2;
      g.position.z = -(box.min.z + box.max.z) / 2;

      board.add(pivot);
      halves.push({ pivot, side, width: (box.max.x - box.min.x) / 2 });
    });

    // --------------------------------------------------------------- pose
    // Declared up here because pose() refits the camera and pose() runs first.
    const cam = { theta: Math.PI / 2, phi: 0.09, dist: 0, target: new THREE.Vector3() };
    let touched = false;
    let span, focus, corners = [];
    const remeasure = () => {
      span = new THREE.Box3().setFromObject(board);
      focus = span.getCenter(new THREE.Vector3());
      corners = [];
      for (const x of [span.min.x, span.max.x])
        for (const y of [span.min.y, span.max.y])
          for (const z of [span.min.z, span.max.z]) corners.push(new THREE.Vector3(x, y, z));
    };

    const pose = () => {
      const s = live.current;
      const tent = (s.tent * Math.PI) / 180;
      const splay = (s.splay * Math.PI) / 180;
      halves.forEach((h) => {
        const m = halves.length === 1 ? 0 : (h.side === 0 ? 1 : -1);
        h.pivot.rotation.set(0, splay * m, tent * m);
        h.pivot.position.set(-(s.gap / 2 + h.width) * m, 0, 0);
        const b = new THREE.Box3().setFromObject(h.pivot);
        h.pivot.position.y = -b.min.y;
      });
      remeasure();
      reshadow();          // the halves moved, so their shadows did
      // Tenting a board or pushing the halves apart changes both where it is
      // and how big it is. Without this the camera kept aiming at where the
      // middle used to be and the board slid off the top corner of the frame.
      // Skipped once someone has moved the camera themselves — their view is
      // theirs, and a slider should not snatch it back.
      if (!touched) {
        cam.target.copy(focus);
        cam.dist = fit();
        place3();
      }
    };

    // ------------------------------------------------------------ camera
    /**
     * How far back to stand so the whole board is in frame.
     *
     * The box is projected onto the view plane and each axis fitted to its own
     * field of view. A bounding sphere fitted to the tighter of the two is the
     * obvious version and is badly wrong for this shape: a keyboard seen from
     * above is wide and shallow, so the sphere is sized by a width the
     * horizontal field has room to spare for, and then that width is fitted
     * into the vertical one. It drew the board at a third of size.
     */
    /** The same projection as fit(), against any box. */
    const fitBox = (box, pad = 1.06) => {
      const at = box.getCenter(new THREE.Vector3());
      const pts = [];
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z));
      return project(pts, at, pad);
    };
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
    // fit() reads the board's own corners; project() is the same sum for any
    // set of points, so a half can be framed by the identical arithmetic.
    function project(pts, at, pad) {
      const dir = new THREE.Vector3(
        Math.sin(cam.phi) * Math.cos(cam.theta),
        Math.cos(cam.phi),
        Math.sin(cam.phi) * Math.sin(cam.theta),
      );
      const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
      if (right.lengthSq() < 1e-8) right.set(Math.sin(cam.theta), 0, -Math.cos(cam.theta));
      right.normalize();
      const up = new THREE.Vector3().crossVectors(right, dir).normalize();
      let hx = 0, hy = 0;
      for (const c of pts) {
        const v = c.clone().sub(at);
        hx = Math.max(hx, Math.abs(v.dot(right)));
        hy = Math.max(hy, Math.abs(v.dot(up)));
      }
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1));
      return Math.max(hx / Math.tan(hFov / 2), hy / Math.tan(vFov / 2)) * pad;
    }

    const place3 = () => {
      cam.phi = Math.max(0.06, Math.min(Math.PI / 2 - 0.02, cam.phi));
      cam.dist = Math.max(60, Math.min(3000, cam.dist));
      camera.position.set(
        cam.target.x + cam.dist * Math.sin(cam.phi) * Math.cos(cam.theta),
        cam.target.y + cam.dist * Math.cos(cam.phi),
        cam.target.z + cam.dist * Math.sin(cam.phi) * Math.sin(cam.theta),
      );
      camera.lookAt(cam.target);
      wake();
    };

    pose();

    // ------------------------------------------------------------- looks
    const applyTheme = () => {
      const s = live.current, th = THEMES[s.theme];
      mats.case.color.set(th.case);
      mats.plate.color.set(th.plate);
      mats.rim.color.set(th.rim);
      mats.stem.color.set(th.stem);
      mats.bezel.color.set(th.bezel);
      for (const k of knobs) {
        if (!k) continue;
        k.base = new THREE.Color(th.bezel);
        k.body.material.color.copy(k.base);
      }
      mats.dot.color.set(th.accent);
      const outer = new THREE.Color(th.outer), inner = new THREE.Color(th.inner);
      caps.forEach((cap, i) => {
        if (!cap) return;
        const meta = capMeta[i] ?? {};
        let colour;
        if (s.tint === "gradient") {
          colour = outer.clone().lerp(inner, Math.min(1, meta.ramp / 0.8));
        } else {
          const tint = typeColour(meta.type);
          // Letters are left alone for the same reason as on the flat board:
          // they are most of a keyboard, and a board where every cap is
          // coloured is a board where the colour says nothing.
          colour = tint && !["letter", "none", "other"].includes(meta.type)
            ? inner.clone().lerp(tint, dark ? 0.55 : 0.4)
            : inner.clone();
        }
        cap.userData.base = colour.clone();
        cap.material.color.copy(colour);
      });
      legends.forEach((l) => {
        if (!l) return;
        l.mesh.material.map?.dispose();
        const t = new THREE.CanvasTexture(labelCanvas(l.text, th.legend, l.icon));
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        l.mesh.material.map = t;
        l.mesh.material.needsUpdate = true;
      });
      for (const sc of screens) {
        paintScreen(sc.ctx, s.theme, info ?? {}, sc.side);
        sc.tex.needsUpdate = true;
      }
      api.current?.highlight(active ?? -1);
      wake();
    };

    const applyVisibility = () => {
      const s = live.current;
      legends.forEach((l) => { if (l) l.mesh.visible = s.legends; });
      for (const m of shells) m.visible = s.cases;
      for (const sc of screens) sc.mesh.visible = s.cases && s.screens;
      caps.forEach((c) => { if (c) c.castShadow = s.shadows; });
      renderer.shadowMap.enabled = s.shadows;
      ground.visible = s.shadows;
      reshadow();
    };

    // Only the display moves. The knob is where the board said its key is, and
    // sliding that would be drawing a switch somewhere it is not.
    const placeScreens = () => {
      const s = live.current;
      for (const a of screenAnchor) {
        if (a.fixed) continue;
        const x = a.home + (s.disp - DEFAULTS.disp) * a.sign;
        a.bezel.position.x = x;
        if (a.screen) a.screen.position.x = x;
      }
      reshadow();          // the display casts one
    };

    applyTheme();
    applyVisibility();

    // ------------------------------------------------------------- input
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let drag = null, lastX = 0, lastY = 0, moved = 0;

    const onDown = (e) => {
      drag = e.button === 2 || e.shiftKey ? "pan" : "orbit";
      lastX = e.clientX; lastY = e.clientY; moved = 0;
      // Throws when the pointer is not actually down on this element, which a
      // synthetic event is not. Capture is a nicety; losing it is not a reason
      // to lose the drag.
      try { el.setPointerCapture(e.pointerId); } catch { /* not captured */ }
    };
    // What is under the pointer, as a key position, or null.
    const under = (e) => {
      const r = el.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(pointer, camera);
      const rings = knobs.filter(Boolean).map((k) => k.group);
      const spun = rings.length ? ray.intersectObjects(rings, true)[0] : null;
      if (spun) {
        let o = spun.object;
        while (o && o.userData.position === undefined) o = o.parent;
        return o?.userData.position ?? null;
      }
      const hit = ray.intersectObjects(caps.filter(Boolean), false)[0];
      return hit ? hit.object.userData.position : null;
    };

    // Hover is worked out at most once a frame, however many move events
    // arrive in it, and React only hears about it when the answer changes.
    let hoverEvt = null, hoverRaf = 0, hoverLast = null, belowLast = false;
    const doHover = () => {
      hoverRaf = 0;
      const e = hoverEvt;
      if (!e) return;
      const r = el.getBoundingClientRect();
      const at = under(e);
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const below = y < r.height * 0.3;
      hoverAt.current = { x, y };
      if (card.current) { card.current.style.left = `${x}px`; card.current.style.top = `${y}px`; }
      if (at !== hoverLast || below !== belowLast) {
        hoverLast = at; belowLast = below;
        setHover(at === null ? null : { at, below });
      }
    };
    const clearHover = () => { hoverEvt = null; hoverLast = null; setHover(null); };

    const onMove = (e) => {
      if (!drag) {
        hoverEvt = e;
        if (!hoverRaf) hoverRaf = requestAnimationFrame(doHover);
        return;
      }
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      touched = true;
      if (hoverLast !== null) clearHover();   // looking around is not pointing at anything
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
        const at = under(e);
        if (at !== null) {
          // A knob turns a notch as feedback, and either way the position
          // opens for editing — under a knob, that position is the push.
          if (knobs[at]) { knobs[at].spinTo += Math.PI / 6; wake(); }
          pick.current?.(at);
        }
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
    el.addEventListener("pointerleave", clearHover);
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
        const lift = (mat, base, on) => {
          mat.color.copy(base);
          if (on) mat.color.lerp(new THREE.Color(0xffffff), dark ? 0.36 : 0.22);
          mat.emissive.setHex(on ? 0x2a2438 : 0x000000);
        };
        caps.forEach((cap, i) => {
          if (!cap?.userData.base) return;
          lift(cap.material, cap.userData.base, i === position);
        });
        // A knob is selectable like any other key position, so it shows it.
        knobs.forEach((k, i) => {
          if (!k?.base) return;
          lift(k.body.material, k.base, i === position);
        });
        wake();
      },
      tap(position) {
        if (caps[position]) {
          target[position] = 1;
          wake();
          setTimeout(() => { target[position] = 0; wake(); }, 140);
        }
      },
      view(name) {
        if (name === "top") { cam.theta = Math.PI / 2; cam.phi = 0.09; }
        else if (name === "front") { cam.theta = Math.PI / 2; cam.phi = 1.32; }
        else if (name === "thumbs") { cam.theta = Math.PI / 2 + 0.85; cam.phi = 0.62; }
        else if (name === "screen") { cam.theta = Math.PI / 2 + 0.1; cam.phi = 0.5; }
        else if (name === "left" || name === "right") { cam.theta = Math.PI / 2; cam.phi = 0.12; }
        else { cam.theta = Math.PI / 2 + 0.3; cam.phi = 0.78; }
        cam.target.copy(focus);
        // One half fills the frame: sixty keys across a panel is small, and
        // half of them at twice the size is the same board read comfortably.
        if (name === "left" || name === "right") {
          const h = halves[name === "left" ? 0 : halves.length - 1];
          const b = new THREE.Box3().setFromObject(h.pivot);
          b.getCenter(cam.target);
          cam.dist = fitBox(b);
        } else if (name === "thumbs" || name === "screen") {
          const at = name === "screen" ? screens[0]?.mesh : caps[caps.length - 1];
          if (at) at.getWorldPosition(cam.target);
          cam.dist = name === "screen" ? 90 : Math.max(120, fit() * 0.4);
        } else {
          cam.dist = fit();
        }
        touched = name !== "top" && name !== "iso";
        place3();
      },
      pose, applyTheme, applyVisibility, placeScreens,
      png() {
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL("image/png");
      },
    };

    // -------------------------------------------------------------- loop
    let last = 0, visible = true;
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) wake();
    });
    io.observe(el);
    const onShow = () => { if (!document.hidden) wake(); };
    document.addEventListener("visibilitychange", onShow);

    const tick = (now) => {
      raf = 0;
      if (!visible || document.hidden) { last = 0; return; }
      // The frame's own timestamp, reset on sleep, so the first frame after a
      // wake is one frame long rather than the length of the nap.
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
      last = now;
      let moving = false;
      const k = Math.min(1, dt * 22);
      for (let i = 0; i < caps.length; i++) {
        if (!caps[i] || press[i] === target[i]) continue;
        // Snap once it is too close to see, or the ease never finishes and the
        // board never gets to sleep.
        let a = press[i] + (target[i] - press[i]) * k;
        if (Math.abs(target[i] - a) < 0.002) a = target[i]; else moving = true;
        press[i] = a;
        caps[i].position.y = CAP_BOT - a * TRAVEL;
        if (legends[i]) legends[i].mesh.position.y = CAP_BOT + CAP_H + 0.06 - a * TRAVEL;
      }
      for (const kn of knobs) {
        if (!kn || kn.spin === kn.spinTo) continue;
        kn.spin += (kn.spinTo - kn.spin) * Math.min(1, dt * 9);
        if (Math.abs(kn.spinTo - kn.spin) < 0.0005) kn.spin = kn.spinTo; else moving = true;
        kn.group.rotation.y = kn.spin;
      }
      renderer.render(scene, camera);
      if (moving) wake(); else last = 0;
    };
    ready = true;
    wake();

    return () => {
      ready = false;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(hoverRaf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onShow);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
      setHover(null);
      api.current = null;
      for (const l of legends) l?.mesh.material.map?.dispose();
      for (const d of junk) d.dispose?.();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [shape, legendKey, screenKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { api.current?.highlight(active ?? -1); }, [active]);
  useEffect(() => { api.current?.applyTheme(); }, [set.theme, set.tint]);
  useEffect(() => { api.current?.applyVisibility(); }, [set.legends, set.cases, set.screens, set.shadows]);
  useEffect(() => { api.current?.pose(); }, [set.tent, set.splay, set.gap]);
  useEffect(() => { api.current?.placeScreens(); }, [set.disp]);

  const put = (k) => (v) => setSet((s) => ({ ...s, [k]: v }));
  const savePng = () => {
    const data = api.current?.png();
    if (!data) return;
    const a = document.createElement("a");
    a.download = `keyboard-${set.theme}.png`;
    a.href = data;
    a.click();
  };

  if (!supported) {
    return (
      <p className="ctl__hint">
        This browser has no WebGL, so the board cannot be drawn in three
        dimensions. The flat view has everything this one does.
      </p>
    );
  }

  return (
    <>
      <div className="board3d">
        <div className="board3d__view" ref={host} tabIndex={0} role="application"
             aria-label="The board in three dimensions. Click a key to edit it." />
        {/* The same card the flat board shows, at the pointer rather than at
            the key: a keycap in perspective has no one edge to hang it off. */}
        {hover && detail?.(hover.at) && (
          <div ref={card} className="keycard board3d__card" role="presentation"
               data-below={hover.below ? "" : undefined}
               style={{ left: hoverAt.current.x, top: hoverAt.current.y }}>
            <dl className="keycard__rows">
              {detail(hover.at).filter(([, v]) => v).map(([label, value]) => (
                <div className="keycard__row" key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        <div className="board3d__views">
          {[["top", "Top"], ["iso", "Iso"], ["left", "Left"], ["right", "Right"],
            ["front", "Front"], ["thumbs", "Thumbs"], ["screen", "Screen"]].map(([k, label]) => (
            <button key={k} className="zoom__btn" onClick={() => api.current?.view(k)}>{label}</button>
          ))}
        </div>
      </div>

      <details className="board3d__panel">
        <summary>Board appearance</summary>

        <h5 className="codes__title">Keycap colourway</h5>
        <div className="swatches">
          {Object.entries(THEMES).map(([k, t]) => (
            <button key={k} className={"sw" + (set.theme === k ? " is-active" : "")}
                    aria-pressed={set.theme === k} onClick={() => put("theme")(k)}>
              <i style={{ background: `linear-gradient(135deg, ${t.outer} 0 50%, ${t.inner} 50% 100%)` }} />
              {t.name}
            </button>
          ))}
        </div>

        <h5 className="codes__title">Colour the caps by</h5>
        <div className="row row--wrap">
          {/* Type is the default because it is the only one that tells you
              anything: the same colours the legend and the flat board use. */}
          <button className={"pill" + (set.tint === "type" ? " is-active" : "")}
                  onClick={() => put("tint")("type")}>Key type</button>
          <button className={"pill" + (set.tint === "gradient" ? " is-active" : "")}
                  onClick={() => put("tint")("gradient")}>Gradient</button>
        </div>

        <h5 className="codes__title">Ergonomics</h5>
        <Slide label="Tenting" unit="°" min={0} max={35} step={1}
               value={set.tent} onChange={put("tent")} />
        <Slide label="Splay" unit="°" min={0} max={30} step={1}
               value={set.splay} onChange={put("splay")} />
        <Slide label="Split gap" unit=" mm" min={0} max={240} step={2}
               value={set.gap} onChange={put("gap")} />
        {/* The knob is at a reported key position, so there is nothing to
            inset. The display is the piece that was placed. */}
        <Slide label="Display inset" unit=" mm" min={8} max={34} step={0.5}
               value={set.disp} onChange={put("disp")} />

        <h5 className="codes__title">Show</h5>
        <div className="row row--wrap">
          {[["legends", "Legends"], ["cases", "Case"],
            ["screens", "Displays"], ["shadows", "Shadows"]].map(([k, label]) => (
            <button key={k} className={"pill" + (set[k] ? " is-active" : "")}
                    aria-pressed={!!set[k]} onClick={() => put(k)(!set[k])}>{label}</button>
          ))}
        </div>

        <div className="row row--wrap">
          <button className="btn" onClick={savePng}>Save a PNG</button>
          <button className="btn btn--ghost" onClick={() => setSet({ ...DEFAULTS })}>
            Back to defaults
          </button>
        </div>
      </details>
    </>
  );
}

function Slide({ label, unit, min, max, step, value, onChange }) {
  const id = `b3d-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="ctl">
      <div className="ctl__head">
        <label className="ctl__label" htmlFor={id}>{label}</label>
        <span className="ctl__value">{value}{unit}</span>
      </div>
      <input id={id} className="range" type="range" min={min} max={max} step={step}
             value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
