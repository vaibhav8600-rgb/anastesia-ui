// A droplet where you pressed.
//
// One delegated listener rather than a handler per button: every control that
// wants this already shares a class with the sheen, and buttons come and go as
// tabs mount. The listener only writes two custom properties and flips an
// attribute — the animation itself is CSS, so nothing here runs per frame.
//
// The position is the whole point, which is why this is not pure CSS: a
// :active ripple can only grow from the centre, and on a tab as wide as
// "Import/Export" that is visibly not where you clicked.

const TARGETS = ".btn, .pill, .theme-btn, .vbtn, .tab";

export function ripples(root = document) {
  root.addEventListener("pointerdown", (e) => {
    const el = e.target.closest?.(TARGETS);
    if (!el || el.disabled) return;

    const r = el.getBoundingClientRect();
    el.style.setProperty("--rx", `${((e.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty("--ry", `${((e.clientY - r.top) / r.height) * 100}%`);

    // Restarting a CSS animation needs the attribute to actually leave the
    // element between presses; a reflow read is what forces that to happen
    // rather than being coalesced with the re-adding below.
    el.removeAttribute("data-droplet");
    void el.offsetWidth;
    el.setAttribute("data-droplet", "");
  }, { passive: true });

  // Left behind, the attribute would replay the animation on any later style
  // recalculation that restarts it.
  root.addEventListener("animationend", (e) => {
    if (e.animationName === "droplet") e.target.removeAttribute?.("data-droplet");
  }, true);
}
