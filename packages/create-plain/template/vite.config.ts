import { defineConfig } from "vite";
import plain from "plain/vite";

// 使用已发布的 plain 包（npm i plain）。
// 若在框架仓库内部开发并想指向本地 dist/，参考 examples/*/vite.config.js 的别名写法。
export default defineConfig({
  plugins: [plain()],
});
