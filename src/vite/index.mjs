// Plain Vite 插件：真实项目的构建集成
//
// 职责：
//   1) esbuild 剥掉 TypeScript 类型（jsx: preserve），得到干净的 JSX-JS
//   2) 交给 plain 编译器，产出「直接构建 DOM」的代码（无虚拟 DOM）
//   3) 把 server() 函数物理写进 .plain/server.mjs，客户端只留 rpc 桩
//   4) dev 模式下提供 /_plain/rpc 中间件

import { compile } from "../compiler/index.mjs";
import { updateServerManifest, writeServerManifest } from "../compiler/manifest.mjs";
import { transformWithEsbuild } from "vite";
import path from "node:path";

export default function plainPlugin(options = {}) {
  const { serverEntry = ".plain/server.mjs", include = /\.(tsx|jsx)$/ } = options;
  const registry = new Map(); // name -> 可执行的 server 函数
  let root = process.cwd();

  // dev 下每次只合并「本文件新识别到的」函数，避免把别的模块挤掉
  const flushIncremental = (entries) => {
    if (!entries.length) return;
    updateServerManifest(entries, path.join(root, serverEntry));
  };

  // build 结束前整体重写一次，保证清单与产出完全一致
  const flushAll = () => {
    if (!registry.size) return;
    writeServerManifest(
      Array.from(registry, ([name, fn]) => ({ name, body: fn.__plainBody })),
      path.join(root, serverEntry)
    );
  };

  return {
    name: "plain",
    enforce: "pre",

    configResolved(cfg) {
      root = cfg.root || process.cwd();
    },

    configureServer(server) {
      if (options.rpc === false) return;
      const handler = makeRpcHandler(registry);
      // 返回函数 => 中间件会被插到 Vite 内部中间件之前，避免被 SPA 兜底吞掉
      return () => {
        server.middlewares.use("/_plain/rpc", handler);
      };
    },

    async transform(code, id) {
      if (id.includes("node_modules")) return null;
      if (!include.test(id)) return null;

      // 1) 去 TS 类型，保留 JSX
      const stripped = await transformWithEsbuild(code, id, {
        jsx: "preserve",
        loader: id.endsWith(".tsx") ? "tsx" : id.endsWith(".jsx") ? "jsx" : "ts",
        target: "es2022",
      });

      // 2) Plain 编译
      const result = compile(stripped.code, id.split("/").pop() || "module.jsx");

      // 3) 登记 server 函数（物理剥离）
      if (result.serverFunctions.length) {
        const fresh = [];
        for (const fn of result.serverFunctions) {
          const f = evalFn(fn.body, fn.name);
          f.__plainBody = fn.body;
          registry.set(fn.name, f);
          fresh.push({ name: fn.name, body: fn.body });
        }
        flushIncremental(fresh);
      }

      return { code: result.code, map: null };
    },

    buildEnd() {
      flushAll();
    },
  };
}

/** dev 模式下的 /_plain/rpc 处理器 */
function makeRpcHandler(registry) {
  return function plainRpc(req, res, next) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end("Method Not Allowed");
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      try {
        const { name, args } = JSON.parse(raw || "{}");
        const fn = registry.get(name);
        if (!fn) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          return res.end(
            JSON.stringify({ error: `unknown server fn: ${name}` })
          );
        }
        const result = await fn(...(args || []));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ result: result === undefined ? null : result })
        );
      } catch (e) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
  };
}

function evalFn(body, name) {
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${body});`)();
  } catch (e) {
    console.warn(`[plain] server 函数 ${name} 无法解析: ${e.message}`);
    return () => {
      throw new Error(`server fn ${name} unavailable`);
    };
  }
}
