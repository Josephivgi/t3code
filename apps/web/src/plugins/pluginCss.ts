/** Settings and other app dialogs sit at z-50; a plugin must never stack above them. */
export const PLUGIN_MAX_Z_INDEX = 40;

/** Caps every `z-index` a plugin's stylesheet sets, so plugin UI can never cover Settings. */
/** `decodeURIComponent` that returns the input when it is not valid percent-encoding. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function clampPluginCss(css: string): string {
  return css.replace(
    /z-index\s*:\s*([^;}!]+?)\s*(!important)?\s*(?=[;}]|$)/gi,
    (match, value: string, important: string | undefined) =>
      /^(auto|inherit|initial|revert|revert-layer|unset)$/i.test(value.trim()) ||
      value.trim().endsWith(`, ${PLUGIN_MAX_Z_INDEX})`)
        ? match
        : `z-index: min(${value.trim()}, ${PLUGIN_MAX_Z_INDEX})${important ? " !important" : ""}`,
  );
}
