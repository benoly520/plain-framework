import { defineConfig } from "vite";
import plain from "../../src/vite/index.mjs";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  plugins: [plain({ serverEntry: ".plain/server.mjs", root: __dirname })],
  resolve: {
    alias: {
      plain: path.resolve(__dirname, "../../src/runtime/index.js"),
    },
  },
  server: { port: 8100 },
  build: { outDir: "dist", emptyOutDir: true },
});
