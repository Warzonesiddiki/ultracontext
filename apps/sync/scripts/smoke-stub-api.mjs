// ARCH-003 smoke harness: a stand-in UltraContext API.
//
// The daemon's contract with the server is three calls — GET /contexts?limit=1
// (connectivity), POST /contexts (create), POST /contexts/:id (append). This
// stub answers all three, records every request to a JSONL log, and nothing
// else, so a smoke run of the real daemon proves the whole extracted pipeline
// (config → sources → ingest → HTTP) without standing up the API + a database.
import http from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const LOG = process.env.STUB_LOG ?? "/tmp/uc-smoke/requests.jsonl";
const PORT = Number(process.env.STUB_PORT ?? 8799);
mkdirSync(path.dirname(LOG), { recursive: true });

let created = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    const isAppend = req.method === "POST" && /^\/contexts\/[^/]+$/.test(req.url ?? "");
    if (req.method === "POST" && (req.url ?? "") === "/contexts") created += 1;

    appendFileSync(LOG, JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      append: isAppend,
      contextId: isAppend ? decodeURIComponent(req.url.split("/")[2] ?? "") : null,
      payloadCount: Array.isArray(body) ? body.length : 1,
      roles: Array.isArray(body) ? body.map((entry) => entry?.role) : [body?.role ?? null],
      messages: Array.isArray(body)
        ? body.map((entry) => String(entry?.content?.message ?? "").slice(0, 60))
        : [String(body?.content?.message ?? "").slice(0, 60)],
      metadata: Array.isArray(body) ? body[0]?.metadata : body?.metadata,
      createMetadata: req.method === "POST" && (req.url ?? "") === "/contexts" ? body?.metadata : undefined,
    }) + "\n");

    res.setHeader("content-type", "application/json");
    if (req.method === "GET") { res.end(JSON.stringify({ data: [], limit: 1 })); return; }
    if ((req.url ?? "") === "/contexts") { res.end(JSON.stringify({ id: `ctx_stub_${created}` })); return; }
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`stub ultracontext api listening on 0.0.0.0:${PORT}, logging to ${LOG}`);
});
