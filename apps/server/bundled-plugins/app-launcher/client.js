const ENDPOINT = "http://127.0.0.1:47213";
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';

const call = async (route, body) => {
  const response = await fetch(ENDPOINT + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-azon-launcher": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export default function activate(api) {
  let panel = null;
  let button = null;
  let view = "apps";
  let apps = [];
  let candidates = [];
  let picked = new Set();
  let message = "";

  const close = () => {
    panel?.remove();
    panel = null;
    button?.removeAttribute("data-open");
  };

  const badge = (app) => {
    if (app.icon) {
      const img = el("img", "azl-icon");
      img.src = `${ENDPOINT}/icon/${encodeURIComponent(app.icon)}`;
      img.alt = "";
      img.addEventListener("error", () => img.replaceWith(el("span", "azl-icon azl-letter", app.name[0]?.toUpperCase() ?? "?")));
      return img;
    }
    return el("span", "azl-icon azl-letter", app.name[0]?.toUpperCase() ?? "?");
  };

  const render = () => {
    if (!panel) return;
    panel.replaceChildren();
    const head = el("div", "azl-head");
    head.append(el("span", "azl-title", view === "apps" ? "App Launcher" : "Import from App Launcher"));
    const toggle = el("button", "azl-link", view === "apps" ? "Import" : "Back");
    toggle.addEventListener("click", () => (view === "apps" ? openImport() : openApps()));
    head.append(toggle);
    panel.append(head);
    if (message) panel.append(el("div", "azl-note", message));
    const list = el("div", "azl-list");
    if (view === "apps") {
      if (apps.length === 0 && !message) list.append(el("div", "azl-note", "No apps yet. Use Import to bring in the ones from App Launcher."));
      for (const app of apps) {
        const row = el("div", "azl-row");
        const open = el("button", "azl-main");
        open.append(badge(app), el("span", "azl-name", app.name), el("span", "azl-kind", app.kind === "app" ? "" : app.kind));
        open.addEventListener("click", async () => {
          try {
            await call("/launch", { id: app.id });
            close();
          } catch (error) {
            message = error.message;
            render();
          }
        });
        const remove = el("button", "azl-x", "×");
        remove.title = "Remove from this launcher";
        remove.addEventListener("click", async () => {
          await call("/remove", { id: app.id }).catch(() => {});
          apps = apps.filter((entry) => entry.id !== app.id);
          render();
        });
        row.append(open, remove);
        list.append(row);
      }
    } else {
      for (const app of candidates) {
        const label = el("label", "azl-row azl-pick");
        const box = el("input");
        box.type = "checkbox";
        box.checked = app.imported || picked.has(app.id);
        box.disabled = app.imported;
        box.addEventListener("change", () => {
          if (box.checked) picked.add(app.id);
          else picked.delete(app.id);
          render();
        });
        label.append(box, badge(app), el("span", "azl-name", app.name), el("span", "azl-kind", app.imported ? "imported" : app.kind === "app" ? "" : app.kind));
        list.append(label);
      }
    }
    panel.append(list);
    if (view === "import" && candidates.length > 0) {
      const foot = el("div", "azl-foot");
      const all = candidates.filter((app) => !app.imported);
      const selectAll = el("button", "azl-link", "Select all");
      selectAll.addEventListener("click", () => {
        picked = new Set(all.map((app) => app.id));
        render();
      });
      const go = el("button", "azl-primary", picked.size ? `Import ${picked.size}` : "Import");
      go.disabled = picked.size === 0;
      go.addEventListener("click", async () => {
        try {
          await call("/import", { ids: [...picked] });
          picked = new Set();
          message = "";
          await openApps();
        } catch (error) {
          message = error.message;
          render();
        }
      });
      foot.append(selectAll, go);
      panel.append(foot);
    }
    position();
  };

  const position = () => {
    if (!panel || !button) return;
    const rect = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, rect.left)}px`;
    panel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  };

  const openApps = async () => {
    view = "apps";
    message = "";
    try {
      apps = (await call("/apps")).apps;
    } catch {
      apps = [];
      message = "The launcher service is not running. Restart the app once to start it.";
    }
    render();
  };

  const openImport = async () => {
    view = "import";
    message = "";
    picked = new Set();
    try {
      candidates = (await call("/candidates")).apps;
      if (candidates.length === 0) message = "App Launcher has no apps to import.";
    } catch (error) {
      candidates = [];
      message = error.message;
    }
    render();
  };

  const toggle = () => {
    if (panel) return close();
    panel = el("div", "azl-panel");
    document.body.append(panel);
    button?.setAttribute("data-open", "");
    void openApps();
  };

  // The button's row item. The app re-renders the footer when the layout changes (t3-code icons, Azon labels),
  // which replaces the Settings item we cloned, so the clone is rebuilt to match the current one.
  let row = null;

  const mount = () => {
    // Clone the Settings button so the new one matches the footer's other icon buttons.
    const settings = document.querySelector('[data-sidebar="footer"] [data-sidebar="menu-item"] [aria-label="Settings"]');
    const item = settings?.closest('[data-sidebar="menu-item"]');
    if (!item) return;
    // The Azon layout labels the footer buttons, so the clone gets a label too.
    const labeled = Boolean(settings.querySelector("span"));
    if (row?.isConnected && row.previousElementSibling === item && row.dataset.labeled === String(labeled)) return;
    if (row) {
      close();
      row.remove();
      row = null;
      button = null;
    }
    const clone = item.cloneNode(true);
    clone.dataset.azonLauncher = "";
    clone.dataset.labeled = String(labeled);
    const target = clone.querySelector("button") ?? clone.firstElementChild;
    for (const attr of [...target.attributes]) if (attr.name.startsWith("data-base-ui") || attr.name.startsWith("aria-")) target.removeAttribute(attr.name);
    target.setAttribute("aria-label", "App Launcher");
    target.title = "App Launcher";
    target.innerHTML = ICON;
    if (labeled) target.insertAdjacentHTML("beforeend", '<span class="truncate">App Launcher</span>');
    target.addEventListener("click", toggle);
    item.parentElement.insertBefore(clone, item.nextSibling);
    row = clone;
    button = target;
  };

  const observer = new MutationObserver(() => mount());
  observer.observe(document.body, { childList: true, subtree: true });
  mount();

  const onPointer = (event) => {
    if (panel && !panel.contains(event.target) && !button?.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", position);

  api.onCleanup(() => {
    observer.disconnect();
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", position);
    close();
    document.querySelectorAll("[data-azon-launcher]").forEach((node) => node.remove());
  });
  api.log("App Launcher button added to the sidebar footer.");
}
