/**
 * "Shimmering singleton" — when a singleton window's open control is pressed while that window is
 * already open, run a brief light-streak around its border to draw the eye to it (instead of silently
 * doing nothing). Vendored from the base system; the module only needs the effect itself, called
 * directly by the singleton Shop window when it re-focuses without a fresh render.
 *
 * `.cp-shimmer-ring` is a dedicated overlay element (NOT a `::after`), so UI modules that style window
 * pseudo-elements can't clobber it; it is removed when the animation finishes. The CSS lives in the
 * module stylesheet; on a system without it the ring is simply invisible (graceful no-op).
 */

const SHIMMER_MS = 950; // a touch longer than the CSS animation so it always finishes cleanly

/** @param {Application|JQuery|HTMLElement} target  An app (uses its .element) or a raw element. */
export function shimmerWindow(target) {
  const raw = target?.element;
  const el = raw?.[0] ?? (raw instanceof HTMLElement ? raw : (target instanceof HTMLElement ? target : null));
  if (!el?.appendChild) return;

  el.querySelectorAll(":scope > .cp-shimmer-ring").forEach((n) => n.remove()); // restart on rapid re-open
  const ring = (el.ownerDocument ?? document).createElement("div");
  ring.className = "cp-shimmer-ring";
  el.appendChild(ring);

  clearTimeout(el._cpShimmerTimer);
  el._cpShimmerTimer = setTimeout(() => ring.remove(), SHIMMER_MS);
}
