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
  assertNoNameCollision,
  updateServerManifest,
  writeServerManifest,
} from "../compiler/manifest.js";
import { check, formatIssues } from "../lint.js";
import { transformWithEsbuild } from "vite";
import path from "node:path";
import fs from "node:fs";
import { renderToStringWithData } from "../server/render.js";
import { renderPage } from "../server/index.js";

export default function plainPlugin(options: {
  serverEntry?: string;
  include?: RegExp;
  rpc?: boolean;
  /**
   * HMR 热更新（默认开启，仅 dev 生效）。
   * - true（默认）：为每个模块注入 import.meta.hot.accept —— 改动组件时**不整页刷新**，
   *   只重建相关挂载点的 DOM 子树。保住：window 滚动 / 区间之外的 DOM / 模块级 signal 值；
   *   丢失：被重建子树内的焦点、未受控输入的值、局部滚动（详见 `src/runtime/hmr.ts` 顶部说明）。
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
  /**
   * **dev 下的 SSR**（可选）。给**源码**入口就行 —— 不必先构建：
   *
   *   plain({ ssr: { entry: "./entry-server.tsx" } })
   *
   * 页面导航（GET、看起来像页面）会交给服务端渲染：模块走 vite 的 SSR 管线加载，
   * 所以改代码立刻生效，`server()` 直调用的是同一份 dev 注册表（也不依赖 `.plain/server.mjs`）。
   * 模板默认 `root/index.html`，需含 `<!--plain-ssr-->` 与 `<!--plain-data-->` 两个占位注释。
   *
   * 生产路径是另一件事（给的是**已构建**的入口）：`serve({ ssr: { template, entry } })`。
   */
  ssr?: { entry: string; template?: string };
} = {}): Plugin {
  const {
    serverEntry = ".plain/server.mjs",
    include = /\.(tsx|jsx)$/,
    lint = "error",
    hmr = true,
    ssr,
  } = options;
  const registry = new Map<string, any>(); // name -> 可执行的 server 函数（仅 dev 需要）
  /** name -> 函数体源码。清单只要文本，build 不解析函数体（见下方 transform 注释） */
  const registryByBody = new Map<string, string>();
  /** name -> 来源模块绝对路径。多入口下同名函数是「静默互相覆盖」的头号来源，靠它查重 */
  const registryFrom = new Map<string, string>();
  /** dev 下才需要把函数体求值成可调用对象（给 /_plain/rpc 用）；build 只要源码文本 */
  let needsCallable = false;
  let root = process.cwd();

  // dev 下每次只合并「本文件新识别到的」函数，避免把别的模块挤掉
  const flushIncremental = (entries: any[]) => {
    if (!entries.length) return;
    updateServerManifest(entries, path.join(root, serverEntry));
  };

  // build 结束前整体重写一次，保证清单与产出完全一致
  const flushAll = () => {
    if (!registryByBody.size) return;
    const entries = Array.from(registryByBody, ([name, body]) => ({
      name,
      body,
      from: registryFrom.get(name),
    }));
    writeServerManifest(entries, path.join(root, serverEntry));
  };

  return {
    name: "plain",
    enforce: "pre",

    configResolved(cfg: any) {
      root = cfg.root || process.cwd();
    },

    configureServer(server: any) {
      // dev 下的 SSR：页面导航交给服务端渲染（生产路径见 serve({ ssr })）。
      // 必须**在这里直接 use** —— vite 的内部中间件（含 index.html 的兜底）是在
      // configureServer 之后装的；放进「返回的函数」里就晚了，`/` 会被 vite 自己先 serve 掉。
      if (ssr) {
        installDevSsr(server, {
          root: () => root,
          entry: ssr.entry,
          template: ssr.template,
          // dev 的 handler 就是内存里那份注册表（transform 已求值成可调用对象），
          // 所以 dev 不需要 .plain/server.mjs
          getHandlers: () => Object.fromEntries(registry),
        });
      }
      if (options.rpc === false) return;
      // dev 才需要可调用对象；标记后 transform 才会求值函数体
      needsCallable = true;
      // 不依赖调用顺序：把在 configureServer 之前已登记的 body 补求值一遍，
      // 这样无论 transform 先来还是 configureServer 先来，RPC 都能调用到函数。
      for (const [name, body] of registryByBody) {
        if (!registry.has(name)) registry.set(name, evalFn(body, name));
      }
      const handler = makeRpcHandler(registry);
      // 返回函数 => 中间件会被插到 Vite 内部中间件之前，避免被 SPA 兜底吞掉
      return () => {
        server.middlewares.use("/_plain/rpc", handler);
      };
    },

    async transform(this: any, code: string, id: string) {
      if (id.includes("node_modules")) return null;
      // 先去掉 query（dev 的 `?t=` / `?v=` 不算文件扩展名）：
      // 不然热更后的那次 transform 会被当成「非 Plain 模块」直接跳过，
      // 浏览器拿到的是 esbuild 留下的 JSX —— 编译链在 HMR 之后就断了。
      const fileName = id.split("?")[0];
      if (!include.test(fileName)) return null;
      // dev（watchMode）下也要可调用对象：真实 dev 会先跑 configureServer，
      // 但这里再兜一道，避免依赖调用顺序（HMR / 单测里 transform 可能先发生）。
      if ((this as any).meta && (this as any).meta.watchMode) needsCallable = true;

      // 0) 契约检查（默认开启）：AI 常犯的错在编译前就拦掉
      if (lint) {
        const issues = check(code, fileName);
        if (issues.length) {
          // level 决定它是不是闸门：`error` 让构建失败；`warn`（写法偏好类规则，
          // 如 PLAIN_E1115 React 拼写属性名）只提示，绝不阻断构建。
          const blocking = issues.filter((i: any) => i.level === "error");
          if (blocking.length && lint === "error") {
            throw toLintError(issues, fileName);
          }
          reportWarn(this, formatIssues(issues, fileName));
        }
      }

      // 1) 去 TS 类型，保留 JSX
      const stripped = await transformWithEsbuild(code, id, {
        jsx: "preserve",
        loader: fileName.endsWith(".tsx")
          ? "tsx"
          : fileName.endsWith(".jsx")
            ? "jsx"
            : "ts",
        target: "es2022",
      });

      // 2) Plain 编译。mapSource 用真实模块路径，devtools 才能把产物定位回源文件；
      //    keyBase 单独给「resource 调用点 key」用**项目相对路径**（见 RFC §3.3）：
      //    可读、不泄漏构建机绝对路径，且 SSR 构建与客户端构建对同一份源码得到同一个 key。
      const result = compile(stripped.code, id.split("/").pop() || "module.jsx", {
        mapSource: id,
        keyBase: path.relative(root, fileName),
      });

      // 3) 登记 server 函数（物理剥离）
      if (result.serverFunctions.length) {
        const freshEntries: any[] = [];
        for (const fn of result.serverFunctions) {
          const prevFrom = registryFrom.get(fn.name);
          // 多入口 / 多模块下同名 server 函数会被静默合并成一条 —— 那是
          // 最贵的失败（客户端还在调旧桩名，服务端实现已被另一个覆盖）。
          // 同一文件重复 transform（HMR）不算冲突，只有跨文件才算。
          if (prevFrom && prevFrom !== fileName) {
            assertNoNameCollision([
              { name: fn.name, body: "", from: prevFrom },
              { name: fn.name, body: "", from: fileName },
            ]);
          }
          // 清单只需要函数体文本；只有 dev 的 /_plain/rpc 需要「可调用的函数」。
          // build 不求值 —— 少一处 new Function，CSP 面更小，也避免构建期执行到
          // 任何非预期的代码（函数体本该只跑在服务端运行时，而不是构建机）。
          if (needsCallable) {
            const f = evalFn(fn.body, fn.name);
            registry.set(fn.name, f);
          }
          registryByBody.set(fn.name, fn.body);
          registryFrom.set(fn.name, fileName);
          freshEntries.push({ name: fn.name, body: fn.body, from: fileName });
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
 *      新模块、再 hmrApply 热替换/重跑受影响的挂载点；dispose 里快照 signal 现值。
 *      hmrApply 返回 false（认不出根组件 / 没有挂载点）时调用 invalidate()，
 *      让 vite 退回整页刷新 —— 绝不静默留在旧代码上。
 *      这条路径也让**懒加载（`import()`）进来的模块**改动能生效：它不是挂载模块，
 *      但 hmrApply 会把挂载点的根组件全部重跑，从而取到新版本。
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
    const __applied = __plainApply(${JSON.stringify(moduleId)}, __newMod);
    import.meta.hot.data.__plainSnap = __plainSnap(__newMod);
    if (!__applied) import.meta.hot.invalidate();
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

/**
 * dev 下的 SSR 中间件：给**源码**入口即可，不必先构建。
 *
 * 与生产路径（`ssrMiddleware`）的差别只有「模块从哪来」与「谁给 handlers」：
 *   - 模块：vite 的 `ssrLoadModule`（走同一条 transform 管线 —— 改代码立刻生效）；
 *   - handlers：插件内存里的 dev 注册表（所以 dev 不需要 `.plain/server.mjs`）；
 *   - 模板：源码 `index.html`，经 `transformIndexHtml` 注入 vite 客户端、改写脚本引用。
 * 「两个占位注释 + 载荷转义」那套规则复用 `renderPage` —— 生产与 dev 只有一份。
 */
function installDevSsr(
  server: any,
  opts: {
    root: () => string;
    entry: string;
    template?: string;
    getHandlers: () => Record<string, (...args: any[]) => any>;
  }
): void {
  const entryUrlOf = (): string => {
    const root = opts.root();
    const rel = path.relative(root, path.resolve(root, opts.entry));
    return "/" + rel.split(path.sep).join("/");
  };

  server.middlewares.use(async (req: any, res: any, next: any) => {
    const url = (req.url || "/").split("?")[0];
    // 只接手「看起来像页面导航」的 GET：dev 的 /@vite/client、/@fs/…、/node_modules/…、
    // 以及带扩展名的资源一律放行 —— 否则会把 vite 自己的东西也拦下来。
    const looksLikePage =
      req.method === "GET" &&
      !url.startsWith("/@") &&
      !url.startsWith("/node_modules/") &&
      !/\.[a-zA-Z0-9]+$/.test(url);
    if (!looksLikePage) return next();

    try {
      const mod: any = await server.ssrLoadModule(entryUrlOf());
      const App =
        typeof mod.App === "function"
          ? mod.App
          : typeof mod.default === "function"
            ? mod.default
            : null;
      if (!App) {
        throw new Error(
          `SSR 入口 ${entryUrlOf()} 没有导出 App 或 default —— 渲染需要一个根组件`
        );
      }
      const { html, data } = await renderToStringWithData(App, {
        container: false,
        handlers: opts.getHandlers(),
        url,
      });
      const tplPath = path.resolve(opts.root(), opts.template || "index.html");
      // 模板先过 vite：注入 @vite/client、把 ./entry-client.tsx 改写成 dev 路径
      const tpl = await server.transformIndexHtml(
        url,
        fs.readFileSync(tplPath, "utf8")
      );
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(renderPage(tpl, html, data));
    } catch (e: any) {
      // 编译 / 契约检查 / 渲染错误：明确报出来，别吞成白屏
      const msg = (e && e.message) || String(e);
      const logger = server.config && server.config.logger;
      if (logger && typeof logger.error === "function") logger.error(`[plain ssr] ${msg}`);
      // eslint-disable-next-line no-console
      else console.error(`[plain ssr] ${msg}`);
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`[plain ssr] ${msg}`);
    }
  });
}
