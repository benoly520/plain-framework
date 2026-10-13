// Plain Vite 插件：真实项目的构建集成
//
// 职责：
//   1) esbuild 剥掉 TypeScript 类型（jsx: preserve），得到干净的 JSX-JS
//   2) 交给 plain 编译器，产出「直接构建 DOM」的代码（无虚拟 DOM）
//   3) 把 server() 函数物理写进 .plain/server.mjs，客户端只留 rpc 桩
//   4) dev 模式下提供 /_plain/rpc 中间件

import type { Plugin } from "vite";
import { compile, PlainCompileError } from "../compiler/index.js";
import {
  updateServerManifest,
  writeServerManifest,
} from "../compiler/manifest.js";
import { check, formatIssues } from "../lint.js";
import { transformWithEsbuild } from "vite";
import path from "node:path";

export default function plainPlugin(options: {
  serverEntry?: string;
  include?: RegExp;
  rpc?: boolean;
  /**
   * 契约检查（默认开启）。AI 写错时构建就该失败，而不是静默产出语义不同的代码。
   * - "error"（默认）：有问题直接让该模块的 transform 失败
   * - "warn"：只告警，适合把 Plain 接入存量项目时过渡
   * - false：关闭
   */
  lint?: "error" | "warn" | false;
} = {}): Plugin {
  const {
    serverEntry = ".plain/server.mjs",
    include = /\.(tsx|jsx)$/,
    lint = "error",
  } = options;
  const registry = new Map<string, any>(); // name -> 可执行的 server 函数
  let root = process.cwd();

  // dev 下每次只合并「本文件新识别到的」函数，避免把别的模块挤掉
  const flushIncremental = (entries: any[]) => {
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

    configResolved(cfg: any) {
      root = cfg.root || process.cwd();
    },

    configureServer(server: any) {
      if (options.rpc === false) return;
      const handler = makeRpcHandler(registry);
      // 返回函数 => 中间件会被插到 Vite 内部中间件之前，避免被 SPA 兜底吞掉
      return () => {
        server.middlewares.use("/_plain/rpc", handler);
      };
    },

    async transform(this: any, code: string, id: string) {
      if (id.includes("node_modules")) return null;
      if (!include.test(id)) return null;

      const fileName = id.split("?")[0];

      // 0) 契约检查（默认开启）：AI 常犯的错在编译前就拦掉
      if (lint) {
        const issues = check(code, fileName);
        if (issues.length) {
          if (lint === "error") throw toLintError(issues, fileName);
          reportWarn(this, formatIssues(issues, fileName));
        }
      }

      // 1) 去 TS 类型，保留 JSX
      const stripped = await transformWithEsbuild(code, id, {
        jsx: "preserve",
        loader: id.endsWith(".tsx") ? "tsx" : id.endsWith(".jsx") ? "jsx" : "ts",
        target: "es2022",
      });

      // 2) Plain 编译。mapSource 用真实模块路径，devtools 才能把产物定位回源文件
      const result = compile(stripped.code, id.split("/").pop() || "module.jsx", {
        mapSource: id,
      });

      // 3) 登记 server 函数（物理剥离）
      if (result.serverFunctions.length) {
        const freshEntries: any[] = [];
        for (const fn of result.serverFunctions) {
          const f = evalFn(fn.body, fn.name);
          f.__plainBody = fn.body;
          registry.set(fn.name, f);
          freshEntries.push({ name: fn.name, body: fn.body });
        }
        flushIncremental(freshEntries);
      }

      // 把编译器产出的 line 级 sourcemap 交给 vite 链式合并
      return { code: result.code, map: result.map ?? null };
    },

    buildEnd() {
      flushAll();
    },
  };
}

/** 把 lint 问题包装成结构化编译错误，构建失败的输出里带规则码与位置 */
function toLintError(issues: any[], fileName: string): PlainCompileError {
  const first = issues[0];
  const fixable = issues.filter((i: any) => i.fix).length;
  return new PlainCompileError({
    code: "PLAIN_E2001",
    file: fileName,
    line: first.line,
    column: first.column,
    detail: `契约检查未通过（${issues.length} 处）：\n${formatIssues(issues, fileName)}`,
    hint: fixable
      ? `其中 ${fixable} 处可自动修：运行 \`plaindev check --fix\``
      : "按上面的规则码修正写法后重新构建",
  });
}

/** warn 模式下优先走 vite 的告警通道，单测里没有插件上下文时退回 console */
function reportWarn(ctx: any, message: string): void {
  if (ctx && typeof ctx.warn === "function") ctx.warn(message);
  // eslint-disable-next-line no-console
  else console.warn(`[plain] ${message}`);
}

/** dev 模式下的 /_plain/rpc 处理器 */
function makeRpcHandler(registry: Map<string, any>) {
  return function plainRpc(req: any, res: any, next: any) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end("Method Not Allowed");
    }
    let raw = "";
    req.on("data", (c: any) => (raw += c));
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
        res.end(JSON.stringify({ error: String((e && (e as any).message) || e) }));
      }
    });
  };
}

function evalFn(body: string, name: string): any {
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${body});`)();
  } catch (e) {
    console.warn(`[plain] server 函数 ${name} 无法解析: ${(e as Error).message}`);
    return () => {
      throw new Error(`server fn ${name} unavailable`);
    };
  }
}
