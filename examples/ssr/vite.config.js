import { defineConfig } from "vite";
import plain from "../../dist/vite/index.js";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  plugins: [plain({ serverEntry: ".plain/server.mjs" })],
  resolve: {
    alias: {
      plain: path.resolve(__dirname, "../../dist/runtime/index.js"),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
