"use strict";
// SQLite週案日誌テスト専用サーバー。現行server.jsとは独立してポート3001で起動する。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.WEEKLY_TEST_PORT || 3001);
const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "apps", "weekly-planYou-sqlite");
const DB_PATH = process.env.MORIBASE_TEST_DB || path.join(ROOT, "data", "moribase.db");
const LOG_DIR = path.join(ROOT, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
function logError(label, err) {
  const detail = err && err.stack ? err.stack : String(err);
  const line = `[${new Date().toISOString()}] ${label}: ${detail}\n`;
  console.error(line.trim());
  try { fs.appendFileSync(path.join(LOG_DIR, "weekly-plan-test-error.log"), line); } catch (_) {}
}
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Client-Id, X-Lock-Token, Accept, Origin, Authorization, Cache-Control, Pragma");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}
function reply(res, status, value) {
  if (res.writableEnded) return;
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp"
};
function serveApp(res, pathname) {
  const prefix = "/weekly-planYou-sqlite/";
  if (!pathname.startsWith(prefix)) return reply(res, 404, { ok: false, message: "Not Found" });
  let relative;
  try { relative = decodeURIComponent(pathname.slice(prefix.length)); }
  catch (_) { return reply(res, 400, { ok: false, message: "Invalid path" }); }
  if (!relative) relative = "index.html";
  const fullPath = path.resolve(APP_DIR, relative);
  if (!fullPath.startsWith(APP_DIR + path.sep) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return reply(res, 404, { ok: false, message: "Not Found" });
  }
  cors(res);
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(fullPath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": relative === "version.json" ? "no-store" : "no-cache"
  });
  fs.createReadStream(fullPath).on("error", (err) => logError("static read", err)).pipe(res);
}
const handleTestApi = require("./lib/weekly-plan-test").makeHandler({ dbPath: DB_PATH, logError });
const server = http.createServer(async (req, res) => {
  cors(res);
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch (_) { return reply(res, 400, { ok: false, message: "Invalid URL" }); }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname.startsWith("/api/weekly-plan-test/")) {
      await handleTestApi(req, res, url);
    } else if (req.method === "GET" && url.pathname === "/weekly-planYou-sqlite") {
      res.writeHead(302, { Location: "/weekly-planYou-sqlite/" }); res.end();
    } else if (req.method === "GET") {
      serveApp(res, url.pathname);
    } else {
      reply(res, 404, { ok: false, message: "Not Found" });
    }
  } catch (err) {
    logError("request", err);
    reply(res, 500, { ok: false, message: "テストサーバーでエラーが発生しました。" });
  }
});
server.on("error", (err) => logError("server", err));
server.listen(PORT, "0.0.0.0", () => {
  console.log(`SQLite週案日誌テストサーバー起動: http://localhost:${PORT}/weekly-planYou-sqlite/`);
  console.log(`テストDB: ${DB_PATH}`);
  console.log("現行 server.js (ポート3000) は変更しません。");
});
