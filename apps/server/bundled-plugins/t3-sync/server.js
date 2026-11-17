import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const PORT = 3795;
const DB = path.join(os.homedir(), ".t3", "userdata", "statev2.sqlite");
const ACTIVE = new Set(["preparing", "starting", "queued", "running", "waiting"]);

export default async function activate({ log }) {
  let db = null;
  const open = () => {
    if (db) return db;
    if (!fs.existsSync(DB)) throw new Error("T3 Code database not found at " + DB);
    db = new DatabaseSync(DB, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    return db;
  };
  const textOf = (payload) => {
    try {
      const p = JSON.parse(payload);
      if (typeof p.text === "string") return p.text;
      if (Array.isArray(p.content)) return p.content.map((c) => c.text ?? "").join("");
    } catch {}
    return "";
  };

  const threads = () => {
    const d = open();
    const rows = d
      .prepare(
        `SELECT t.thread_id id, t.title, t.default_provider provider, t.updated_at updatedAt, p.title project,
        (SELECT r.status FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id ORDER BY r.ordinal DESC LIMIT 1) runStatus,
        (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests q WHERE q.thread_id = t.thread_id AND q.status = 'pending') pendingRequests
       FROM orchestration_v2_projection_threads t
       LEFT JOIN projection_projects p ON p.project_id = t.project_id
       WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
       ORDER BY t.updated_at DESC LIMIT 150`,
      )
      .all();
    const lastMsg = d.prepare(
      `SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 6`,
    );
    return rows.map((r) => {
      const last = lastMsg
        .all(r.id)
        .map((m) => textOf(m.payload_json))
        .find((t) => t.trim());
      const status =
        r.runStatus === "waiting" || r.pendingRequests > 0
          ? "waiting"
          : ACTIVE.has(r.runStatus)
            ? "working"
            : "idle";
      return {
        id: r.id,
        title: r.title,
        provider: r.provider,
        project: r.project ?? "",
        updatedAt: r.updatedAt,
        status,
        preview: last ? last.slice(0, 160) : "",
      };
    });
  };

  const messages = (id) => {
    const rows = open()
      .prepare(
        `SELECT role, created_at createdAt, streaming, payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 60`,
      )
      .all(id);
    return rows
      .reverse()
      .map((m) => ({
        role: m.role,
        createdAt: m.createdAt,
        streaming: !!m.streaming,
        text: textOf(m.payload_json).slice(0, 6000),
      }))
      .filter((m) => m.text.trim());
  };

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    try {
      const url = new URL(req.url, "http://x");
      let body;
      if (url.pathname === "/threads") body = threads();
      else if (url.pathname.startsWith("/threads/"))
        body = messages(decodeURIComponent(url.pathname.slice(9)));
      else {
        res.writeHead(404).end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    } catch (e) {
      db = null;
      res
        .writeHead(500, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
  server.on("error", (e) => log("sync server error: " + e.message));
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  log("T3 Code sync reading " + DB + " on 127.0.0.1:" + PORT);
  // Plugin guide: a server that opens a port returns a cleanup, so a hot reload can reuse the port.
  return () => {
    server.close();
    server.closeAllConnections?.();
    try {
      db?.close();
    } catch {}
    db = null;
  };
}
