import { describe, expect, it } from "vite-plus/test";

import { clampPluginCss } from "./pluginCss";

describe("clampPluginCss", () => {
  it("caps every z-index below the app dialogs, keeping !important", () => {
    expect(
      clampPluginCss(".a{z-index:60}.b { z-index: 99999 !important; color:red }.c{z-index:5}"),
    ).toBe(
      ".a{z-index: min(60, 40)}.b { z-index: min(99999, 40) !important; color:red }.c{z-index: min(5, 40)}",
    );
  });
});
