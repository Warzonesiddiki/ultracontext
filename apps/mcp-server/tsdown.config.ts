import { defineConfig } from "tsdown";

// Bundle the stdio entry so the declared bin (dist/stdio.js) is a real,
// self-contained file. Runtime deps stay external — they resolve from the
// installing package's node_modules.
export default defineConfig({
  entry: { stdio: "src/stdio.ts" },
  format: "esm",
  platform: "node",
  outDir: "dist",
  dts: false,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  external: [/^@modelcontextprotocol\//, /^ultracontext/, /^zod/],
});
