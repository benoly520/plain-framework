import { defineConfig } from "vite";
import plain from "../../dist/vite/index.js";
import path from "node:path";

// 多入口示例：两个独立 HTML 页面（首页 / 控制台）共享同一套框架与服务端函数。
//
// 框架侧已经保证：多个入口里定义的 server() 函数会被写进**同一个** .plain/server.mjs
// 清单，跨文件同名会在构建期报冲突（见 test/vite-plugin.test.mjs），所以这里两个入口
// 各自用的 server 函数名字必须不同（或像 shared.ts 那样抽到一个模块里只定义一次）。
export default defineConfig({
  root: __dirname,
  plugins: [plain({ serverEntry: ".plain/server.mjs", root: __dirname })],
  resolve: {
    alias: {
      plain: path.resolve(__dirname, "../../dist/runtime/index.js"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Vite 原生的多入口配置：两个 HTML 各是一个入口，框架不介入打包层。
    rollupOptions: {
      input: {
        landing: path.resolve(__dirname, "index.html"),
        dashboard: path.resolve(__dirname, "app.html"),
      },
    },
  },
});
