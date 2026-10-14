import { defineConfig } from "vite";
import plain from "../../dist/vite/index.js";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  // ssr.entry 给**源码**入口：dev 下页面导航直接走服务端渲染，不必先构建
  // （生产路径见 server.mjs 里的 serve({ ssr })，那里给的是构建产物）
  plugins: [plain({ serverEntry: ".plain/server.mjs", ssr: { entry: "./entry-server.tsx" } })],
  resolve: {
    alias: {
      plain: path.resolve(__dirname, "../../dist/runtime/index.js"),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
