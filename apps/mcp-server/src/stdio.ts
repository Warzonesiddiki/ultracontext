import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { UltraContext } from "ultracontext";

import { createMcpServer } from "./server.js";
import { sdkReader } from "./reader-sdk.js";
import { loadConfig } from "./config.js";

// -- start stdio transport ----------------------------------------------------

const { apiKey, baseUrl, source } = loadConfig();
if (source !== "env") {
  // keep stdout clean for the JSON-RPC stream — diagnostics go to stderr
  console.error(`ultracontext-mcp: using ${source} configuration (${baseUrl})`);
}
const uc = new UltraContext({ apiKey, baseUrl });
const mcp = createMcpServer(sdkReader(uc));
const transport = new StdioServerTransport();

await mcp.connect(transport);
