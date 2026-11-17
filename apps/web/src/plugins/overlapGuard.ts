import { clampPluginCss, PLUGIN_MAX_Z_INDEX } from "./pluginCss";

/** App dialogs sit at z-50. Anything at or above this is capped; app UI below it is left alone. */
const APP_DIALOG_Z_INDEX = 50;

/** Style elements already clamped. A WeakSet, so plugin script cannot forge membership. */
const clampedStyles = new WeakSet<Element>();
/** Elements app code put in the top layer on purpose. Plugin script has no way to add to it. */
const appTopLayerElements = new WeakSet<Element>();

/** App code calls this for the one element it puts in the top layer on purpose. */
export function allowAppTopLayer(element: Element): void {
  appTopLayerElements.add(element);
}

/** Caps an element's inline z-index so plugin script cannot raise it above app dialogs. */
export function clampInlineZIndex(element: HTMLElement): void {
  const value = element.style.zIndex;
  if (value === "" || value === "auto") return;
  const direct = Number(value);
  // calc() and var() are not numbers; the browser's computed value is what stacks.
  const effective = Number.isFinite(direct) ? direct : Number(getComputedStyle(element).zIndex);
  if (Number.isFinite(effective) && effective >= APP_DIALOG_Z_INDEX) {
    element.style.setProperty("z-index", String(PLUGIN_MAX_Z_INDEX), "important");
  }
}

function clampStyleElement(element: HTMLStyleElement): void {
  // Dev servers inject the app's own CSS as style elements; only clamp in the packaged app.
  if (import.meta.env.DEV || clampedStyles.has(element)) return;
  clampedStyles.add(element);
  const text = element.textContent ?? "";
  const clamped = clampPluginCss(text);
  if (clamped !== text) element.textContent = clamped;
}

function reclampStyleElement(element: HTMLStyleElement): void {
  clampedStyles.delete(element);
  clampStyleElement(element);
}

function clampTree(node: Node): void {
  if (node instanceof HTMLStyleElement) clampStyleElement(node);
  if (!(node instanceof HTMLElement)) return;
  clampInlineZIndex(node);
  for (const child of node.querySelectorAll<HTMLElement>("[style], style")) {
    if (child instanceof HTMLStyleElement) clampStyleElement(child);
    else clampInlineZIndex(child);
  }
}

let installed = false;

/**
 * Plugin script runs with full DOM access, so the stylesheet clamp alone cannot keep a plugin off
 * Settings. This also caps inline z-index, clamps style elements the script adds, and refuses the
 * top layer (showModal, popovers, fullscreen), which no z-index can stack under.
 */
export function installPluginOverlapGuard(): void {
  if (installed) return;
  installed = true;

  const nativeShowModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    if (appTopLayerElements.has(this)) return nativeShowModal.call(this);
    console.warn("[plugin guard] dialog.showModal() is not allowed outside app code.");
  };
  const nativeShowPopover = HTMLElement.prototype.showPopover;
  HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) {
    if (appTopLayerElements.has(this)) return nativeShowPopover.call(this);
    console.warn("[plugin guard] showPopover() is not allowed outside app code.");
  };
  const nativeTogglePopover = HTMLElement.prototype.togglePopover;
  HTMLElement.prototype.togglePopover = function togglePopover(this: HTMLElement, force?: boolean) {
    if (appTopLayerElements.has(this)) return nativeTogglePopover.call(this, force);
    console.warn("[plugin guard] togglePopover() is not allowed outside app code.");
    return false;
  };
  const nativeRequestFullscreen = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function requestFullscreen(
    this: Element,
    options?: FullscreenOptions,
  ) {
    if (appTopLayerElements.has(this)) return nativeRequestFullscreen.call(this, options);
    console.warn("[plugin guard] requestFullscreen() is not allowed outside app code.");
    return Promise.resolve();
  };

  clampTree(document.documentElement);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof HTMLElement) {
        clampInlineZIndex(record.target);
      } else if (record.type === "characterData") {
        const parent = record.target.parentElement;
        if (parent instanceof HTMLStyleElement) reclampStyleElement(parent);
      } else {
        for (const node of record.addedNodes) {
          clampTree(node);
          const parent = node.parentElement;
          if (parent instanceof HTMLStyleElement && node.nodeType === Node.TEXT_NODE) {
            reclampStyleElement(parent);
          }
        }
      }
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style"],
  });
}
