// Worker: loads a Pyodide (WASM) interpreter once, then runs each submitted
// snippet in a FRESH Python namespace so state never leaks between students.
// WASM is inherently sandboxed (no host filesystem / network / privileges), so
// this is safe to run on any host — no nsjail, no privileged container needed.
import { parentPort } from "node:worker_threads";
import { loadPyodide } from "pyodide";

let pyodide;
const ready = (async () => {
  pyodide = await loadPyodide();
  // Signal readiness to the parent so it only routes work to warm workers.
  parentPort.postMessage({ ready: true });
})();

parentPort.on("message", async (msg) => {
  if (!msg || typeof msg.id === "undefined") return;
  await ready;
  const { id, code } = msg;
  let out = "";
  let err = "";
  pyodide.setStdout({ batched: (s) => { out += s + "\n"; } });
  pyodide.setStderr({ batched: (s) => { err += s + "\n"; } });
  let ns;
  try {
    ns = pyodide.globals.get("dict")(); // fresh namespace (builtins auto-injected by CPython exec)
    await pyodide.runPythonAsync(code, { globals: ns });
  } catch (e) {
    const m = (e && e.message) ? e.message : String(e);
    err += m.endsWith("\n") ? m : m + "\n";
  } finally {
    try { if (ns) ns.destroy(); } catch {}
    try { pyodide.setStdout({}); pyodide.setStderr({}); } catch {}
  }
  parentPort.postMessage({ id, stdout: out, stderr: err });
});
