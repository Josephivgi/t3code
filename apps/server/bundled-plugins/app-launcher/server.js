import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 47213;
const HEADER = "x-azon-launcher";
const here = path.dirname(fileURLToPath(import.meta.url));
const listFile = path.join(here, "apps.json");
const dataRoot = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "App Launcher");

const readList = () => {
  try {
    const list = JSON.parse(fs.readFileSync(listFile, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};
const writeList = (list) => fs.writeFileSync(listFile, JSON.stringify(list, null, 2));

/** One shape for App Launcher's database rows and its bridge summaries. */
const normalize = (raw) => {
  const launch = raw.launch ?? raw;
  const kind = raw.kind === "website" || raw.kind === "command" ? raw.kind : "app";
  const iconText = typeof raw.icon === "string" ? raw.icon : "";
  const icon = iconText.startsWith("stored image ") ? iconText.slice(13) : /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(iconText) ? iconText : "";
  return {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    description: String(raw.description || ""),
    kind,
    icon,
    exe: launch.exe || "",
    args: Array.isArray(launch.args) ? launch.args : [],
    cwd: raw.cwd && raw.cwd !== "(home folder)" ? raw.cwd : launch.cwd || "",
    url: launch.url || "",
    browser: launch.browser && launch.browser !== "default" ? launch.browser : "",
    command: launch.command || "",
    shell: launch.shell === "powershell" ? "powershell" : "cmd",
    terminal: launch.terminal !== false,
  };
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

async function readLauncher() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataRoot, "app-launcher.db"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT id, app_json FROM apps ORDER BY sort, created_at").all();
      return rows.map((row) => normalize({ ...JSON.parse(row.app_json), id: row.id }));
    } finally {
      db.close();
    }
  } catch {
    // node:sqlite missing or the file is locked: ask the running App Launcher instead.
  }
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(dataRoot, "bridge.json"), "utf8"));
  } catch {
    throw new Error("App Launcher is not installed, so its apps could not be read.");
  }
  if (!info.pid || !alive(info.pid)) throw new Error("Open App Launcher once so its apps can be read.");
  const response = await fetch(`${info.url}/tools/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "app_list", arguments: {} }),
  });
  const result = await response.json();
  return JSON.parse(result.content[0].text).map(normalize);
}

const run = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore", ...options });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

async function launch(app) {
  if (app.kind === "website") {
    if (app.browser) return run(app.browser, [app.url], { detached: true });
    return run("explorer.exe", [app.url], { detached: true });
  }
  if (app.kind === "command") {
    const cwd = app.cwd || os.homedir();
    const dir = path.join(here, "commands");
    fs.mkdirSync(dir, { recursive: true });
    const comspec = process.env.ComSpec || "cmd.exe";
    const title = app.name.replace(/["^&|<>%]/g, "") || app.id;
    if (app.shell === "powershell") {
      const script = path.join(dir, `${app.id}.ps1`);
      fs.writeFileSync(script, `﻿${app.command}\r\n`, "utf8");
      const ps = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"];
      if (app.terminal) {
        return run(comspec, ["/d", "/c", `start "${title}" /D "${cwd}" powershell.exe ${ps.join(" ")} -NoExit -File "${script}"`], { cwd, windowsVerbatimArguments: true, windowsHide: true });
      }
      return run("powershell.exe", [...ps, "-NonInteractive", "-File", script], { cwd, windowsHide: true });
    }
    const script = path.join(dir, `${app.id}.cmd`);
    fs.writeFileSync(script, `${app.command.split(/\r?\n/).join("\r\n")}\r\n`, "utf8");
    if (app.terminal) {
      return run(comspec, ["/d", "/c", `start "${title}" /D "${cwd}" "${comspec}" /d /k "${script}"`], { cwd, windowsVerbatimArguments: true, windowsHide: true });
    }
    return run(comspec, ["/d", "/s", "/c", `"${script}"`], { cwd, windowsVerbatimArguments: true, windowsHide: true });
  }
  if (!fs.existsSync(app.exe)) throw new Error(`${app.name} is not at ${app.exe}.`);
  return run(app.exe, app.args, { cwd: app.cwd || path.dirname(app.exe), detached: true });
}

const ICON_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp" };

/** Only the app's own page may call this: the desktop scheme, or a local web page. */
const allowedOrigin = (origin) => /^(t3code(-dev)?:\/\/[^/]+|https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(origin || "");

export default async function activate({ log }) {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, {
        "content-type": type,
        "access-control-allow-origin": origin,
        "access-control-allow-headers": `content-type, ${HEADER}`,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        vary: "origin",
      });
      res.end(Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body));
    };
    // Images in <img> tags send no Origin header, so icons are the one route that skips the check.
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/icon/")) {
      const file = path.basename(decodeURIComponent(url.pathname.slice(6)));
      const type = ICON_TYPES[path.extname(file).toLowerCase()];
      try {
        if (!type) throw new Error("type");
        const bytes = fs.readFileSync(path.join(dataRoot, "icons", file));
        res.writeHead(200, { "content-type": type, "cache-control": "max-age=300" });
        return res.end(bytes);
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }
    if (!allowedOrigin(origin)) {
      res.writeHead(403);
      return res.end();
    }
    if (req.method === "OPTIONS") return send(204, "");
    if (req.headers[HEADER] !== "1") return send(403, { error: "Missing header." });
    let body = {};
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return send(400, { error: "Invalid JSON." });
      }
    }
    try {
      if (url.pathname === "/apps") return send(200, { apps: readList() });
      if (url.pathname === "/candidates") {
        const have = new Set(readList().map((app) => app.id));
        const apps = (await readLauncher()).map((app) => ({ ...app, imported: have.has(app.id) }));
        return send(200, { apps });
      }
      if (url.pathname === "/import") {
        const wanted = new Set(Array.isArray(body.ids) ? body.ids : []);
        const list = readList();
        const have = new Set(list.map((app) => app.id));
        const added = (await readLauncher()).filter((app) => wanted.has(app.id) && !have.has(app.id));
        writeList([...list, ...added]);
        return send(200, { added: added.length });
      }
      if (url.pathname === "/remove") {
        writeList(readList().filter((app) => app.id !== body.id));
        return send(200, {});
      }
      if (url.pathname === "/launch") {
        const app = readList().find((entry) => entry.id === body.id);
        if (!app) return send(404, { error: "Not in the launcher." });
        await launch(app);
        return send(200, {});
      }
      return send(404, { error: "Unknown route." });
    } catch (error) {
      return send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve) => {
    server.once("error", (error) => {
      log(`Could not listen on 127.0.0.1:${PORT}: ${error.message}`);
      resolve();
    });
    server.listen(PORT, "127.0.0.1", () => {
      log(`Listening on 127.0.0.1:${PORT}`);
      resolve();
    });
  });
  // The app runs this before a changed server.js starts, so the new copy can take the port.
  return () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
