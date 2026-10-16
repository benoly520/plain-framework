// 官网构建配置：和 examples/ 一样，直接消费框架仓库根的 dist/（不依赖 npm 发包）。
//
// 基路径：GitHub Pages 的项目站点部署在 https://<user>.github.io/<repo>/ 下，
// 由 SITE_BASE 传入；本地开发/预览用默认的 "/"。
//   SITE_BASE=/plain-framework/ pnpm run build:site
import { defineConfig } from "vite";
import path from "node:path";
import plain from "../dist/vite/index.js";

const root = __dirname;

export default defineConfig({
  root,
  base: process.env.SITE_BASE ?? "/",
  plugins: [plain({ root, serverEntry: ".plain/server.mjs" })],
  resolve: {
    // 官网同样直接引用框架源码产物，避免依赖 node_modules 里的 plain
    alias: { plain: path.resolve(root, "../dist/runtime/index.js") },
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 8200 },
});
