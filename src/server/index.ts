// Plain 服务端运行时：生产环境 SSR + RPC 端点 + 静态服务
// 用法（任意 Node HTTP 框架都套得上）：
//   import { ssrMiddleware, rpcMiddleware, staticMiddleware } from "plain/server";
//   app.use(ssrMiddleware({ template: "dist/index.html", entry: ".plain/ssr/entry-server.js" }));
//   app.use(rpcMiddleware());
//   app.use(staticMiddleware("dist"));

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { renderToStringWithData } from "./render.js";

/** SSR 模板里的两个占位符 */
export const SSR_SLOT = "<!--plain-ssr-->";
export const DATA_SLOT = "<!--plain-data-->";
/** 首屏数据载荷在页面里的元素 id（`hydrate` 按它自动读回） */
const DATA_ID = "plain-data";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** 加载编译器产出的服务端清单 .plain/server.mjs */
export async function loadHandlers(manifest = ".plain/server.mjs"): Promise<Record<string, any>> {
  const abs = path.resolve(manifest);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `[plain] 找不到服务端清单 ${abs}。先跑一次 dev 或 build 生成它。`
    );
  }
  const mod = await import(pathToFileURL(abs).href + `?t=${Date.now()}`);
  return mod.__plainHandlers || {};
}

/**
 * 标准 Node (req, res, next) 中间件：处理 POST /_plain/rpc
 * 选项：{ manifest, endpoint, handlers }
 */
export function rpcMiddleware(options: {
  manifest?: string;
  endpoint?: string;
  handlers?: Record<string, (...args: any[]) => any>;
} = {}): (req: any, res: any, next?: () => void) => void {
  const { endpoint = "/_plain/rpc" } = options;
  let handlersPromise: Promise<Record<string, any>> | null = null;
  const getHandlers = async (): Promise<Record<string, any>> => {
    if (options.handlers) return options.handlers;
    if (!handlersPromise) handlersPromise = loadHandlers(options.manifest);
    return handlersPromise;
  };

  return async function plainRpc(req: any, res: any, next?: () => void) {
    const url = (req.url || "").split("?")[0];
    if (url !== endpoint) return next ? next() : undefined;
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end("Method Not Allowed");
    }
    let raw = "";
    req.on("data", (c: any) => (raw += c));
    req.on("end", async () => {
      try {
        const { name, args } = JSON.parse(raw || "{}");
        const handlers = await getHandlers();
        const fn = handlers[name];
        if (!fn) {
          res.statusCode = 404;
          return json(res, { error: `unknown server fn: ${name}` });
        }
        const result = await fn(...(args || []));
        json(res, { result: result === undefined ? null : result });
      } catch (e) {
        res.statusCode = 500;
        json(res, { error: String((e && (e as any).message) || e) });
      }
    });
  };
}

function json(res: any, body: any): void {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** 静态文件中间件（用于生产环境托管 dist） */
export function staticMiddleware(
  rootDir: string,
  { spa = true }: { spa?: boolean } = {}
): (req: any, res: any, next?: () => void) => void {
  const root = path.resolve(rootDir);
  return function plainStatic(req: any, res: any, next?: () => void) {
    const rawUrl = (req.url || "/").split("?")[0];
    let rel: string;
    try {
      rel = decodeURIComponent(rawUrl);
    } catch {
      res.statusCode = 400;
      return res.end("Bad Request");
    }
    if (rel.includes("\0")) {
      res.statusCode = 400;
      return res.end("Bad Request");
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(root, "." + path.posix.normalize("/" + rel));
    // 目录穿越防护：解析后的真实路径必须仍在 dist 里
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.statusCode = 403;
      return res.end("Forbidden");
    }
    fs.stat(file, (err: any, st: any) => {
      let target = file;
      if (!err && st.isDirectory()) target = path.resolve(target, "index.html");
      fs.readFile(target, (e: any, buf: any) => {
        if (!e) {
          res.setHeader(
            "content-type",
            MIME[path.extname(target)] || "application/octet-stream"
          );
          return res.end(buf);
        }
        // 只有「看起来像页面导航」的 GET 才走 SPA 兜底；
        // 带扩展名的资源请求该 404 就 404，别把 API 请求吞成 HTML
        const looksLikePage =
          req.method === "GET" && !/\.[a-zA-Z0-9]+$/.test(rawUrl);
        if (spa && looksLikePage) {
          const index = path.join(root, "index.html");
          fs.readFile(index, (e2: any, b2: any) => {
            if (e2) {
              res.statusCode = 404;
              return res.end("Not Found");
            }
            res.setHeader("content-type", MIME[".html"]);
            res.end(b2);
          });
          return;
        }
        res.statusCode = 404;
        return res.end("Not Found");
      });
    });
  };
}

/**
 * 一行起生产服务：SSR（可选）+ 静态托管 dist + RPC
 * serve({ dist: 'dist', manifest: '.plain/server.mjs', port: 3000 })
 * serve({ ssr: { template: 'dist/index.html', entry: '.plain/ssr/entry-server.js' } })
 */
export async function serve(options: {
  dist?: string;
  manifest?: string;
  port?: number;
  endpoint?: string;
  /** 开启 SSR：给模板与 SSR 入口即可 */
  ssr?: { template: string; entry: string; manifest?: string };
} = {}): Promise<http.Server> {
  const {
    dist = "dist",
    manifest = ".plain/server.mjs",
    port = Number(process.env.PORT) || 3000,
    endpoint = "/_plain/rpc",
  } = options;

  const rpc = rpcMiddleware({ manifest, endpoint });
  const statics = staticMiddleware(dist, { spa: true });
  const ssr = options.ssr
    ? ssrMiddleware({ ...options.ssr, manifest: options.ssr.manifest ?? manifest })
    : null;

  const server = http.createServer((req, res) => {
    // 顺序很重要：
    //   1. RPC 最前 —— 否则会被 SPA 兜底吞成 index.html；
    //   2. SSR 其次 —— 要在 SPA 兜底之前，页面导航才会走服务端渲染；
    //   3. 静态托管最后（含 SPA 兜底，兜住没被 SSR 处理的路径）。
    const url = (req.url || "/").split("?")[0];
    if (url === endpoint) return rpc(req, res);
    if (ssr) return ssr(req, res, () => statics(req, res));
    statics(req, res);
  });

  await new Promise((r) => server.listen(port, () => r(undefined)));
  const addr = server.address();
  const real = typeof addr === "object" && addr ? addr.port : port;
  // eslint-disable-next-line no-console
  console.log(`[plain] http://localhost:${real}  (dist=${path.resolve(dist)})`);
  return server;
}

/**
 * ssrMiddleware —— 服务端渲染中间件（Node 标准 `(req, res, next)`，与 `rpcMiddleware` 同形状）。
 *
 * 它把「首屏就有数据」这条链子接起来：
 *   1. `renderToStringWithData(App, { handlers, url })` —— `server()` 直调 + 等静默 + 收集载荷；
 *   2. 把应用 HTML 写进模板的 `<!--plain-ssr-->`，把载荷写进 `<!--plain-data-->`；
 *   3. 载荷以 `<script type="application/json" id="plain-data">` 输出，并**转义 `<`** ——
 *      数据里出现 `</script>` 时不能让它逃出标签。
 *
 * 只接手「看起来像页面导航」的 GET（带扩展名的资源请求、非 GET 一律 `next()`）。
 * 模板缺占位符 / 入口没导出根组件 -> **报错（500）**，不静默降级成一张没有数据的页面。
 *
 * 注意：`entry` 是**已按 SSR 目标构建过**的模块（`vite build --ssr`），
 * 也就是生产路径；dev 下随 vite 一起跑 SSR 另说（不在本中间件职责内）。
 */
export function ssrMiddleware(options: {
  /** 页面模板文件（内含 `<!--plain-ssr-->` 与 `<!--plain-data-->` 两个占位符） */
  template: string;
  /** SSR 入口模块，导出 `App` 或 `default` */
  entry: string;
  /** 服务端函数清单，默认 `.plain/server.mjs` */
  manifest?: string;
}): (req: any, res: any, next?: () => void) => void {
  const { template, entry, manifest = ".plain/server.mjs" } = options;
  const tplPath = path.resolve(template);
  const entryPath = path.resolve(entry);

  interface Prepared {
    tpl: string;
    App: () => any;
    handlers: Record<string, (...args: any[]) => any> | null;
  }
  let prepared: Promise<Prepared> | null = null;

  // 模板与入口只读一次、只 import 一次，进程内复用（改模板要重启 —— 对生产是对的）
  const prepare = (): Promise<Prepared> => {
    if (!prepared) {
      prepared = (async () => {
        const tpl = fs.readFileSync(tplPath, "utf8");
        assertSlot(tpl, SSR_SLOT);
        assertSlot(tpl, DATA_SLOT);
        const mod: any = await import(pathToFileURL(entryPath).href);
        const App =
          typeof mod.App === "function"
            ? mod.App
            : typeof mod.default === "function"
              ? mod.default
              : null;
        if (!App) {
          throw new Error(
            `[plain ssr] SSR 入口 ${entryPath} 没有导出 App 或 default —— 渲染需要一个根组件`
          );
        }
        return { tpl, App, handlers: await loadHandlersIfAny(manifest) };
      })();
      // 失败**不缓存**：下一次请求可以重试（比如第一次请求来得比构建早）
      prepared.catch(() => {
        prepared = null;
      });
    }
    return prepared;
  };

  return function plainSsr(req: any, res: any, next?: () => void) {
    const url = (req.url || "/").split("?")[0];
    const looksLikePage = req.method === "GET" && !/\.[a-zA-Z0-9]+$/.test(url);
    if (!looksLikePage) return next ? next() : undefined;
    void prepare()
      .then(async ({ tpl, App, handlers }) => {
        const { html, data } = await renderToStringWithData(App, {
          container: false,
          handlers,
          url,
        });
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(renderPage(tpl, html, data));
      })
      .catch((e: any) => {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(`[plain ssr] ${(e && e.message) || e}`);
      });
  };
}

/** 首屏数据载荷的 script 标签（转义 `<`：数据里出现 `</script>` 不能逃出标签） */
function payloadTag(data: unknown[]): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/json" id="${DATA_ID}">${json}</script>`;
}

/**
 * 把应用 HTML 与首屏载荷写进模板（**生产与 dev 共用这一处**，规则只有一份）：
 * 先校验占位符（缺了 / 重了都报错），再替换，载荷按 `payloadTag` 转义。
 */
export function renderPage(tpl: string, html: string, data: unknown[]): string {
  assertSlot(tpl, SSR_SLOT);
  assertSlot(tpl, DATA_SLOT);
  return tpl.replace(SSR_SLOT, html).replace(DATA_SLOT, payloadTag(data));
}

/**
 * 校验模板占位符：**缺了**或**出现多次**都报错。
 * 后者同样重要：注入点不明确时（比如占位符被写进了另一段注释里），
 * 静默挑第一处就等于把 HTML 插到看不见的地方。
 */
function assertSlot(tpl: string, slot: string): void {
  const count = tpl.split(slot).length - 1;
  const what = slot === SSR_SLOT ? "应用 HTML" : "首屏数据载荷";
  if (count === 1) return;
  if (count === 0) {
    throw new Error(
      `[plain ssr] 页面模板里缺少占位符 ${slot} —— SSR 需要它来插入${what}。` +
        `请在模板里显式写下 ${SSR_SLOT} 与 ${DATA_SLOT}（见 examples/ssr）`
    );
  }
  throw new Error(
    `[plain ssr] 页面模板里出现了 ${count} 次占位符 ${slot} —— 注入点不明确。` +
      `请只保留一处（注意别把它写进别的注释里）`
  );
}

/**
 * 读服务端清单；**清单不存在不算错**（应用里没有 `server()` 就不需要它），
 * 但要说一声 —— 否则 SSR 期间真去调 `server()` 时报的是「没注入 handlers」，容易查错方向。
 */
async function loadHandlersIfAny(
  manifest: string
): Promise<Record<string, (...args: any[]) => any> | null> {
  if (!fs.existsSync(path.resolve(manifest))) {
    // eslint-disable-next-line no-console
    console.warn(
      `[plain ssr] 没找到服务端清单 ${path.resolve(manifest)}：` +
        `应用里没有 server() 就无需理会；否则先跑一次 build 生成它`
    );
    return null;
  }
  return loadHandlers(manifest);
}
