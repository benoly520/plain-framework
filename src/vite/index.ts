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
   * HMR 热更新（默认开启，仅 dev 生效）。
   * - true（默认）：为每个模块注入 import.meta.hot.accept —— 改动组件时只热替换
   *   它产出的 DOM 子树，不整页刷新（保住焦点/滚动/输入 + 模块级 signal 值）。
   * - false：关闭注入（退化成 vite 默认的整页刷新）。
   */
  hmr?: boolean;
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
    hmr = true,
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
      let outCode = result.code;

      // 4) HMR 注入（仅 dev，且要求 vite 的 import.meta.hot 可用）
      if (hmr && (this as any).meta && (this as any).meta.watchMode) {
        outCode = injectHmr(outCode, id);
      }

      return { code: outCode, map: result.map ?? null };
    },

    /**
     * handleHotUpdate —— 命中 Plain 模块时，不整页刷新，改由注入的
     * import.meta.hot.accept 走「热替换 DOM 子树」路径。
     * 返回空数组即告诉 vite「这些模块无需触发默认 full-reload」。
     */
    handleHotUpdate(ctx: any) {
      if (!hmr) return;
      const file: string = ctx?.file || "";
      if (!include.test(file) || file.includes("node_modules")) return;
      // 交给 vite 的 HMR 管道处理（模块图里挂有我们注入的 accept 回调），
      // 不返回 modules → vite 默认会对该模块做 invalidate + 触发 accept。
      return undefined;
    },

    buildEnd() {
      flushAll();
    },
  };
}

/**
 * 为每个编译模块注入 HMR 支撑代码（不改变模块语义）：
 *
 *   1) 顶部：`__plainBeginModule(id)` —— 记录「当前正在求值的模块 id」，
 *      这样该模块里调用的 mount()/hydrate() 会自动与该 id 关联（零配置）。
 *   2) 顶部 import 到运行时入口的 HMR 辅助（hmrApply / snapshot / restore）。
 *   3) 尾部：注册 import.meta.hot.accept —— 改动时把模块级 signal 快照恢复到
 *      新模块、再 hmrApply 精确热替换该模块的挂载点；dispose 里快照 signal 现值。
 *
 * 注意：**不能把整个模块体包进闭包**（export 语句不允许出现在函数体内）。
 * 因此这里只在首尾追加代码，模块体本身保持原样。
 */
function injectHmr(code: string, id: string): string {
  const moduleId = id.split("?")[0];
  const header =
    `import { __plainBeginModule as __plainBegin, hmrApply as __plainApply, ` +
    `snapshotSignals as __plainSnap, restoreSignals as __plainRestore } from "plain";\n` +
    `__plainBegin(${JSON.stringify(moduleId)});\n`;
  const footer = `
if (import.meta.hot) {
  import.meta.hot.accept((__newMod) => {
    if (!__newMod) { import.meta.hot.invalidate(); return; }
    const __snap = import.meta.hot.data.__plainSnap || {};
    __plainRestore(__newMod, __snap, ${JSON.stringify(moduleId)});
    __plainApply(${JSON.stringify(moduleId)}, __newMod);
    import.meta.hot.data.__plainSnap = __plainSnap(__newMod);
  });
}
`;
  return header + code + "\n" + footer;
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
