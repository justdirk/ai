// dirk.it in-chat Python runner.
// Implements the LibreChat Code Interpreter API surface (POST /exec with an
// X-API-Key header) backed by a small pool of pre-warmed Pyodide workers.
// Each run is isolated (fresh namespace) and bounded by a hard timeout; a run
// that exceeds it has its worker terminated and replaced, so an infinite loop
// from one student can never wedge the service.
import http from "node:http";
import { Worker } from "node:worker_threads";

const API_KEY = process.env.API_KEY || "";
const PORT = parseInt(process.env.PORT || "8000", 10);
const POOL_SIZE = parseInt(process.env.POOL_SIZE || "2", 10);
const TIMEOUT_MS = parseInt(process.env.EXEC_TIMEOUT_MS || "15000", 10);
const MAX_CODE = parseInt(process.env.MAX_CODE_CHARS || "100000", 10);
const workerURL = new URL("./worker.mjs", import.meta.url);

const PY_LANGS = new Set(["py", "python", "python3"]);

let idCounter = 0;
const idle = [];
const waiters = [];

function spawn() {
  const w = new Worker(workerURL);
  w._handlers = new Map();
  w._ready = false;
  w.on("message", (m) => {
    if (m && m.ready) { w._ready = true; idle.push(w); pump(); return; }
    if (m && typeof m.id !== "undefined") {
      const h = w._handlers.get(m.id);
      if (h) { w._handlers.delete(m.id); h(m); }
    }
  });
  w.on("error", () => replace(w));
  w.on("exit", () => {});
  return w;
}

function replace(w) {
  try { w.terminate(); } catch {}
  const i = idle.indexOf(w);
  if (i >= 0) idle.splice(i, 1);
  spawn();
}

function pump() {
  while (waiters.length && idle.length) {
    const res = waiters.shift();
    res(idle.shift());
  }
}

function acquire() {
  return new Promise((res) => {
    if (idle.length) res(idle.shift());
    else waiters.push(res);
  });
}

function release(w) {
  if (waiters.length) waiters.shift()(w);
  else idle.push(w);
}

for (let i = 0; i < POOL_SIZE; i++) spawn();

async function runPython(code) {
  const w = await acquire();
  const id = ++idCounter;
  return await new Promise((resolve) => {
    let done = false;
    const to = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ stdout: "", stderr: `Execution timed out after ${TIMEOUT_MS / 1000}s.` });
      replace(w);
    }, TIMEOUT_MS);
    w._handlers.set(id, (m) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      resolve({ stdout: m.stdout || "", stderr: m.stderr || "" });
      release(w);
    });
    w.postMessage({ id, code });
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-api-key, authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function authed(req) {
  if (!API_KEY) return true;
  const k = req.headers["x-api-key"];
  if (k && k === API_KEY) return true;
  const a = req.headers["authorization"] || "";
  if (a === "Bearer " + API_KEY) return true;
  return false;
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});

  const path = (req.url || "").split("?")[0].replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/" || path.endsWith("/health"))) {
    return send(res, 200, { status: "ok", service: "dirk-coderun", languages: ["py"], pool: POOL_SIZE });
  }

  // Minimal file-endpoint stubs so LibreChat never 500s if it probes them.
  // Match by suffix so any base-URL prefix (with or without /v1) works.
  if (path.endsWith("/upload")) { if (!authed(req)) return send(res, 401, { error: "API key is required" }); return send(res, 200, { files: [] }); }
  if (path.includes("/download/") || path.includes("/files/")) { return send(res, 200, { files: [] }); }

  if (path.endsWith("/exec") || path.endsWith("/exec/programmatic")) {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    if (!authed(req)) return send(res, 401, { error: "API key is required" });
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_CODE + 5000) { req.destroy(); }
    });
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch { return send(res, 400, { error: "invalid json" }); }
      const code = typeof payload.code === "string" ? payload.code : "";
      const lang = String(payload.lang || payload.language || "py").toLowerCase();
      const sessionId = payload.session_id || "s_" + (++idCounter);
      if (!code.trim()) return send(res, 200, { session_id: sessionId, stdout: "", stderr: "", files: [] });
      if (code.length > MAX_CODE) return send(res, 200, { session_id: sessionId, stdout: "", stderr: "Code is too long.", files: [] });
      if (!PY_LANGS.has(lang)) {
        return send(res, 200, { session_id: sessionId, stdout: "", stderr: `This sandbox runs Python only (received "${lang}").`, files: [] });
      }
      try {
        const r = await runPython(code);
        return send(res, 200, { session_id: sessionId, stdout: r.stdout, stderr: r.stderr, files: [] });
      } catch (e) {
        return send(res, 200, { session_id: sessionId, stdout: "", stderr: "Runner error: " + (e && e.message ? e.message : String(e)), files: [] });
      }
    });
    return;
  }

  return send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log("dirk-coderun listening on " + PORT + " (pool " + POOL_SIZE + ")"));
