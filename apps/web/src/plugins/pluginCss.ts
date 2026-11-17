/** Settings and other app dialogs sit at z-50; a plugin must never stack above them. */
export const PLUGIN_MAX_Z_INDEX = 40;

/** Caps every `z-index` a plugin's stylesheet sets, so plugin UI can never cover Settings. */
export function clampPluginCss(css: string): string {
  return css.replace(
    /z-index\s*:\s*([^;}!]+?)\s*(!important)?\s*(?=[;}]|$)/gi,
    (_match, value: string, important: string | undefined) =>
      `z-index: min(${value.trim()}, ${PLUGIN_MAX_Z_INDEX})${important ? " !important" : ""}`,
  );
}
