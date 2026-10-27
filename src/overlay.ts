export const OVERLAY_ATTRIBUTE = "data-reel-overlay";
export const MASK_COLOR = "#000000";

export interface OverlayState {
  cursor: { x: number; y: number } | null;
  caption: string | null;
  captionPosition: "top" | "bottom";
  masks: string[];
}

// The overlay is a child of <html>, not <body>, so page MutationObservers on body never see it (RM-04).
// Mask boxes are rebuilt from live bounding rects on every call, so scrolling or layout changes between frames keep them aligned.
// Returns the mask selectors that matched at least one element, which the recorder uses for its never-matched warning.
export function showOverlayExpression(state: OverlayState): string {
  return `((state) => {
  const root = document.documentElement;
  let overlay = root.querySelector(":scope > [${OVERLAY_ATTRIBUTE}]");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.setAttribute("${OVERLAY_ATTRIBUTE}", "");
    overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;background:none;";
    const cursor = document.createElement("div");
    cursor.dataset.part = "cursor";
    cursor.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;box-sizing:border-box;border-radius:50%;border:2px solid #fff;background:rgba(230,40,60,.85);box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:none;display:none;";
    const caption = document.createElement("div");
    caption.dataset.part = "caption";
    caption.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);max-width:90%;padding:8px 16px;border-radius:6px;background:rgba(0,0,0,.75);color:#fff;font:600 20px/1.35 sans-serif;text-align:center;pointer-events:none;display:none;";
    overlay.append(cursor, caption);
    root.append(overlay);
  }
  for (const old of overlay.querySelectorAll('[data-part="mask"]')) old.remove();
  const matched = [];
  for (const selector of state.masks) {
    let elements;
    try {
      elements = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    if (elements.length === 0) continue;
    matched.push(selector);
    for (const el of elements) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const box = document.createElement("div");
      box.dataset.part = "mask";
      box.style.cssText = "position:fixed;margin:0;padding:0;border:0;pointer-events:none;background:${MASK_COLOR};left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;";
      overlay.prepend(box);
    }
  }
  const cursor = overlay.querySelector('[data-part="cursor"]');
  const caption = overlay.querySelector('[data-part="caption"]');
  if (state.cursor) {
    cursor.style.transform = "translate(" + state.cursor.x + "px," + state.cursor.y + "px)";
    cursor.style.display = "block";
  } else {
    cursor.style.display = "none";
  }
  if (state.caption) {
    caption.textContent = state.caption;
    caption.style.top = state.captionPosition === "top" ? "16px" : "auto";
    caption.style.bottom = state.captionPosition === "bottom" ? "16px" : "auto";
    caption.style.display = "block";
  } else {
    caption.style.display = "none";
  }
  return matched;
})(${JSON.stringify(state)})`;
}

export const REMOVE_OVERLAY_EXPRESSION = `(() => {
  for (const node of document.querySelectorAll("[${OVERLAY_ATTRIBUTE}]")) node.remove();
})()`;
