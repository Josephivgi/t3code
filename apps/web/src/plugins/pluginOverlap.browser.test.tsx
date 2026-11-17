import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { render } from "../../test/render";
import { clampPluginCss } from "./pluginCss";

it("keeps an open Settings-style dialog above a plugin panel that asks for the top z-index", async () => {
  const style = document.createElement("style");
  style.textContent = clampPluginCss(
    ".plugin-panel{position:fixed;inset:0;z-index:2147483647 !important;background:red}",
  );
  document.head.append(style);
  const panel = document.createElement("div");
  panel.className = "plugin-panel";
  document.body.append(panel);
  using _cleanup = {
    [Symbol.dispose]() {
      panel.remove();
      style.remove();
    },
  };

  await using _screen = await render(
    <Dialog open>
      <DialogPopup>
        <p data-testid="settings-body">Settings</p>
      </DialogPopup>
    </Dialog>,
    { router: false },
  );

  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="settings-body"]')).not.toBeNull(),
  );
  const body = document.querySelector('[data-testid="settings-body"]')!;
  const rect = body.getBoundingClientRect();
  const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  expect(top === body || body.contains(top) || top?.contains(body)).toBe(true);
  expect(top?.classList.contains("plugin-panel")).toBe(false);
});

it("keeps a dialog above a plugin element that sets an inline z-index from script", async () => {
  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;inset:0;z-index:2147482000;background:red";
  panel.className = "plugin-inline-panel";
  document.body.append(panel);
  using _cleanup = {
    [Symbol.dispose]() {
      panel.remove();
    },
  };

  await using _screen = await render(
    <Dialog open>
      <DialogPopup>
        <p data-testid="settings-inline-body">Settings</p>
      </DialogPopup>
    </Dialog>,
    { router: false },
  );

  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="settings-inline-body"]')).not.toBeNull(),
  );
  const body = document.querySelector('[data-testid="settings-inline-body"]')!;
  const rect = body.getBoundingClientRect();
  const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  expect(top?.classList.contains("plugin-inline-panel")).toBe(false);
});
