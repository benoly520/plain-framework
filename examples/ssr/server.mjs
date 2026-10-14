// 生产服务：SSR + RPC + 静态托管，一行起。
//
// 先构建（在仓库根目录）：
//   pnpm run build:example:ssr
// 再启动：
//   node examples/ssr/server.mjs      # http://localhost:8300
//
// 打开页面后右键「查看网页源代码」——HTML 里已经带着数据（服务端渲染），
// 而不是等 JS 到了才填。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../dist/server/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

await serve({
  dist: path.join(here, "dist"),
  manifest: path.join(here, ".plain/server.mjs"),
  ssr: {
    template: path.join(here, "dist/index.html"),
    entry: path.join(here, ".plain/ssr/entry-server.js"),
  },
  port: Number(process.env.PORT) || 8300,
});
