import { clampPluginCss, PLUGIN_MAX_Z_INDEX } from "./pluginCss";

/** Marks a style element the host or the guard already clamped. */
const CLAMPED_ATTRIBUTE = "data-plugin-clamped";
/** App code sets this on the one element it puts in the top layer on purpose. */
export const APP_TOP_LAYER_ATTRIBUTE = "data-app-top-layer";

/** Caps an element's inline z-index so plugin script cannot raise it above app dialogs. */
export function clampInlineZIndex(element: HTMLElement): void {
  const value = element.style.zIndex;
  if (value === "" || value === "auto") return;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > PLUGIN_MAX_Z_INDEX) {
    element.style.setProperty("z-index", String(PLUGIN_MAX_Z_INDEX), "important");
  }
}

function clampStyleElement(element: HTMLStyleElement): void {
  if (element.hasAttribute(CLAMPED_ATTRIBUTE)) return;
  element.setAttribute(CLAMPED_ATTRIBUTE, "");
  const text = element.textContent ?? "";
  const clamped = clampPluginCss(text);
  if (clamped !== text) element.textContent = clamped;
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
 * top layer (dialog.showModal, popovers), which no z-index can stack under.
 */
export function installPluginOverlapGuard(): void {
  if (installed) return;
  installed = true;

  const nativeShowModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    if (this.hasAttribute(APP_TOP_LAYER_ATTRIBUTE)) return nativeShowModal.call(this);
    console.warn("[plugin guard] dialog.showModal() is not allowed outside app code.");
  };
  const nativeShowPopover = HTMLElement.prototype.showPopover;
  HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) {
    if (this.hasAttribute(APP_TOP_LAYER_ATTRIBUTE)) return nativeShowPopover.call(this);
    console.warn("[plugin guard] showPopover() is not allowed outside app code.");
  };

  clampTree(document.documentElement);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof HTMLElement) {
        clampInlineZIndex(record.target);
      } else if (record.type === "characterData") {
        const parent = record.target.parentElement;
        if (parent instanceof HTMLStyleElement) {
          parent.removeAttribute(CLAMPED_ATTRIBUTE);
          clampStyleElement(parent);
        }
      } else {
        for (const node of record.addedNodes) {
          clampTree(node);
          const parent = node.parentElement;
          if (parent instanceof HTMLStyleElement && node.nodeType === Node.TEXT_NODE) {
            parent.removeAttribute(CLAMPED_ATTRIBUTE);
            clampStyleElement(parent);
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
