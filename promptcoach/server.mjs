// Prompt Coach middleware — OpenAI-compatible endpoint.
// FIRST message of a conversation: (1) a cheap model rewrites it into a
// well-structured prompt, (2) that improved prompt is shown to the user, then
// (3) a frontier model solves it.
// FOLLOW-UP messages (anything after the first answer): passed straight through
// to the frontier model WITH full conversation history and NO rewrite — so
// refinements like "make it shorter" / "now in Spanish" keep their context.
import http from "node:http";

const GATEWAY = (process.env.GATEWAY_URL || "https://litellm-production-bbed.up.railway.app/v1").replace(/\/+$/, "");
const GATEWAY_KEY = process.env.GATEWAY_KEY || "";
const AUTH = process.env.MIDDLEWARE_AUTH || "";
const OPTIMIZER = process.env.OPTIMIZER_MODEL || "qwen3-14b";
const SOLVER = process.env.SOLVER_MODEL || "kimi-k2";
const PORT = process.env.PORT || 8080;

// A disciplined, teachable prompt-engineering methodology (RCTCEF). The optimizer
// applies each component that adds value, in order, so rewrites are consistently
// well-structured rather than ad hoc.
const OPT_SYS =
  "You are an expert prompt engineer. Rewrite the user's message into the single best possible prompt " +
  "for an AI to answer, following this methodology (RCTCEF). Apply each component that adds value, in order:\n" +
  "1. ROLE - assign the AI an expert persona fit for the task (\"You are a ...\").\n" +
  "2. CONTEXT - state relevant background and the user's implied goal.\n" +
  "3. TASK - one clear, specific instruction of exactly what to produce; split vague asks into concrete sub-goals.\n" +
  "4. CONSTRAINTS - scope, length, tone, audience, what to avoid, and any assumptions to make explicit rather than guess.\n" +
  "5. EXAMPLE / REASONING - if it improves quality, request step-by-step reasoning or give a short illustrative example.\n" +
  "6. FORMAT - the exact output shape (headings, table, list, JSON, word count).\n\n" +
  "Rules: preserve the user's original intent and language; never invent facts the user did not imply; " +
  "do NOT answer the question yourself; be concise - a great prompt is complete, not bloated. " +
  "Output ONLY the improved prompt text - no preamble, no labels, no explanation, no quotes.";

function gw(model, messages, opts = {}) {
  return fetch(GATEWAY + "/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + GATEWAY_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, ...opts })
  });
}

const chunk = delta => "data: " + JSON.stringify({
  id: "pc", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
  model: "prompt-coach", choices: [{ index: 0, delta, finish_reason: null }]
}) + "\n\n";

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "prompt-coach", object: "model", owned_by: "dirk.it" }] }));
  }
  if (req.method === "GET") { res.writeHead(200); return res.end("prompt-coach ok"); }
  if (req.url.replace(/\/+$/, "") !== "/v1/chat/completions") { res.writeHead(404); return res.end("not found"); }

  if (AUTH) {
    const h = req.headers["authorization"] || "";
    if (h !== "Bearer " + AUTH) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "unauthorized" } })); }
  }

  let body = "";
  req.on("data", c => (body += c));
  req.on("end", async () => {
    let payload;
    try { payload = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end("bad json"); }
    const messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
    const wantStream = !!payload.stream;
    let li = -1;
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].role === "user") { li = i; break; } }
    const original = li >= 0 ? (typeof messages[li].content === "string" ? messages[li].content : JSON.stringify(messages[li].content)) : "";

    // Coach ONLY the first user turn. If the conversation already has an
    // assistant reply, this is a follow-up: skip the rewrite entirely and let
    // the solver answer with the full history intact (so refinement works).
    const isFollowUp = messages.some(m => m && m.role === "assistant");

    let improved = original;
    let preamble = "";
    let solverMsgs = messages;

    if (!isFollowUp) {
      // Step 1 — cheap optimizer (first turn only)
      try {
        const or = await gw(OPTIMIZER, [{ role: "system", content: OPT_SYS }, { role: "user", content: original }], { max_tokens: 600, temperature: 0.3 });
        const oj = await or.json();
        improved = (oj.choices && oj.choices[0] && oj.choices[0].message && oj.choices[0].message.content || original).trim();
      } catch (e) { /* fall back to original */ }
      solverMsgs = messages.map((m, i) => (i === li ? { ...m, content: improved } : m));
      preamble = "**📝 Improved prompt** _(auto-structured for you)_\n\n> " + improved.replace(/\n/g, "\n> ") + "\n\n---\n\n";
    }

    // Step 2 — frontier solver
    if (!wantStream) {
      let answer = "";
      try {
        const sr = await gw(SOLVER, solverMsgs, { max_tokens: payload.max_tokens || 2000, temperature: payload.temperature });
        const sj = await sr.json();
        answer = (sj.choices && sj.choices[0] && sj.choices[0].message && sj.choices[0].message.content) || "";
      } catch (e) { answer = "(solver error: " + e.message + ")"; }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        id: "pc-" + Date.now(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "prompt-coach",
        choices: [{ index: 0, message: { role: "assistant", content: preamble + answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }));
    }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    if (preamble) res.write(chunk({ role: "assistant", content: preamble }));
    try {
      const sr = await gw(SOLVER, solverMsgs, { max_tokens: payload.max_tokens || 2000, temperature: payload.temperature, stream: true });
      const reader = sr.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const d = line.slice(5).trim();
          if (d === "[DONE]") continue;
          try { const j = JSON.parse(d); const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content; if (c) res.write(chunk({ content: c })); } catch (e) {}
        }
      }
    } catch (e) { res.write(chunk({ content: "\n\n(solver error: " + e.message + ")" })); }
    res.write("data: " + JSON.stringify({ id: "pc", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "prompt-coach", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(PORT, () => console.log("prompt-coach listening on " + PORT));
