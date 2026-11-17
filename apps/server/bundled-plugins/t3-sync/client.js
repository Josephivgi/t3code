const BASE = "http://127.0.0.1:3795";

export default function activate(api) {
  const root = document.createElement("div");
  root.id = "t3-sync-root";
  root.innerHTML =
    '<button class="t3s-btn" type="button">T3 Code</button><div class="t3s-panel" hidden><div class="t3s-head"><b class="t3s-title">T3 Code threads</b><button class="t3s-back" type="button" hidden>Back</button><button class="t3s-x" type="button">Close</button></div><div class="t3s-body"></div></div>';
  document.body.appendChild(root);
  const btn = root.querySelector(".t3s-btn");
  const panel = root.querySelector(".t3s-panel");
  const body = root.querySelector(".t3s-body");
  const back = root.querySelector(".t3s-back");
  const title = root.querySelector(".t3s-title");
  let open = false;
  let view = null;
  let timer = null;
  let stopped = false;
  let sig = "";

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60
      ? "now"
      : s < 3600
        ? Math.floor(s / 60) + "m"
        : s < 86400
          ? Math.floor(s / 3600) + "h"
          : Math.floor(s / 86400) + "d";
  };
  const get = async (p) => {
    const r = await fetch(BASE + p);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    return r.json();
  };
  const setBody = (key, build) => {
    if (key === sig) return;
    sig = key;
    body.replaceChildren(build());
  };
  const rank = (t) => (t.status === "waiting" ? 0 : t.status === "working" ? 1 : 2);

  const setCounts = (list) => {
    const w = list.filter((t) => t.status === "working").length;
    const q = list.filter((t) => t.status === "waiting").length;
    btn.textContent =
      "T3 Code" + (q ? " · " + q + " waiting" : "") + (w ? " · " + w + " working" : "");
    btn.dataset.state = q ? "waiting" : w ? "working" : "idle";
  };

  async function tick() {
    if (stopped) return;
    try {
      if (open && view) {
        setCounts(await get("/threads"));
        const msgs = await get("/threads/" + encodeURIComponent(view.id));
        setBody("v" + view.id + JSON.stringify(msgs.map((m) => m.text.length)), () => {
          const f = document.createDocumentFragment();
          for (const m of msgs) {
            const d = el("div", "t3s-msg t3s-" + m.role);
            d.append(
              el("div", "t3s-role", m.role + (m.streaming ? " (streaming)" : "")),
              el("div", "t3s-text", m.text),
            );
            f.append(d);
          }
          if (!msgs.length) f.append(el("div", "t3s-empty", "No messages."));
          return f;
        });
      } else {
        const list = await get("/threads");
        setCounts(list);
        if (open) {
          setBody("l" + list.map((t) => t.id + t.status + t.updatedAt).join(), () => {
            const f = document.createDocumentFragment();
            for (const t of [...list].sort((a, b) => rank(a) - rank(b))) {
              const row = el("button", "t3s-row");
              row.type = "button";
              const top = el("div", "t3s-top");
              top.append(
                el("span", "t3s-st t3s-st-" + t.status, t.status === "idle" ? "" : t.status),
                el("span", "t3s-name", t.title),
                el("span", "t3s-age", ago(t.updatedAt)),
              );
              row.append(
                top,
                el("div", "t3s-sub", t.project + (t.preview ? " · " + t.preview.replace(/\s+/g, " ") : "")),
              );
              row.onclick = () => {
                view = t;
                title.textContent = t.title;
                back.hidden = false;
                sig = "";
                tick();
              };
              f.append(row);
            }
            return f;
          });
        }
      }
    } catch (e) {
      btn.textContent = "T3 Code (offline)";
      btn.dataset.state = "idle";
      if (open) setBody("err" + e.message, () => el("div", "t3s-empty", "Cannot read T3 Code: " + e.message));
    }
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(tick, open ? 2000 : 6000);
  }

  btn.onclick = () => {
    open = !open;
    panel.hidden = !open;
    sig = "";
    if (open) tick();
  };
  root.querySelector(".t3s-x").onclick = () => {
    open = false;
    panel.hidden = true;
  };
  back.onclick = () => {
    view = null;
    back.hidden = true;
    title.textContent = "T3 Code threads";
    sig = "";
    tick();
  };
  tick();
  api.onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
    root.remove();
  });
  api.log("T3 Code sync button added");
}
