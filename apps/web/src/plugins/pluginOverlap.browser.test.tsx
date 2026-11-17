import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { render } from "../../test/render";
import { clampPluginCss } from "./pluginCss";
import { installPluginOverlapGuard } from "./overlapGuard";

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

it("guard caps inline z-index, clamps added style elements, and blocks the top layer", async () => {
  installPluginOverlapGuard();
  const inline = document.createElement("div");
  document.body.append(inline);
  inline.style.zIndex = "2147483647";
  const style = document.createElement("style");
  style.textContent = ".guard-probe{z-index:99999}";
  document.head.append(style);
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  using _cleanup = {
    [Symbol.dispose]() {
      inline.remove();
      style.remove();
      dialog.remove();
    },
  };

  await vi.waitFor(() => expect(inline.style.zIndex).toBe("40"));
  await vi.waitFor(() => expect(style.textContent).toContain("min(99999, 40)"));
  dialog.showModal();
  expect(dialog.open).toBe(false);
});
