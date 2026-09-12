import { createServer } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { UltraContext } from "ultracontext";

import { createMcpServer } from "./server.js";
import { sdkReader } from "./reader-sdk.js";
import { loadConfig } from "./config.js";

// -- resolve config (env → local server.json → config.json) -------------------

const { apiKey, baseUrl } = loadConfig();
const port = Number(process.env.MCP_PORT ?? 3100);

// -- start HTTP transport (stateless) -----------------------------------------

const server = createServer(async (req, res) => {
  // health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // only handle /mcp
  if (req.url !== "/mcp") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // stateless: one MCP server + transport per request
  const uc = new UltraContext({ apiKey, baseUrl });
  const mcp = createMcpServer(sdkReader(uc));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);

  // parse body for POST
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    await transport.handleRequest(req, res, body);
    return;
  }

  // GET (SSE) and DELETE
  await transport.handleRequest(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`UltraContext MCP server listening on http://127.0.0.1:${port}/mcp`);
});
