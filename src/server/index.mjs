// Plain 服务端运行时：生产环境 RPC 端点 + 静态服务
// 用法（任意 Node HTTP 框架都套得上）：
//   import { rpcMiddleware } from "plain/server";
//   app.use(rpcMiddleware());

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";

const MIME = {
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
export async function loadHandlers(manifest = ".plain/server.mjs") {
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
export function rpcMiddleware(options = {}) {
  const { endpoint = "/_plain/rpc" } = options;
  let handlersPromise = null;
  const getHandlers = async () => {
    if (options.handlers) return options.handlers;
    if (!handlersPromise) handlersPromise = loadHandlers(options.manifest);
    return handlersPromise;
  };

  return async function plainRpc(req, res, next) {
    const url = (req.url || "").split("?")[0];
    if (url !== endpoint) return next ? next() : undefined;
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end("Method Not Allowed");
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
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
        json(res, { error: String((e && e.message) || e) });
      }
    });
  };
}

function json(res, body) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** 静态文件中间件（用于生产环境托管 dist） */
export function staticMiddleware(rootDir, { spa = true } = {}) {
  const root = path.resolve(rootDir);
  return function plainStatic(req, res, next) {
    const rawUrl = (req.url || "/").split("?")[0];
    let rel;
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
    fs.stat(file, (err, st) => {
      let target = file;
      if (!err && st.isDirectory()) target = path.resolve(target, "index.html");
      fs.readFile(target, (e, buf) => {
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
          fs.readFile(index, (e2, b2) => {
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
 * 一行起生产服务：静态托管 dist + RPC
 * serve({ dist: 'dist', manifest: '.plain/server.mjs', port: 3000 })
 */
export async function serve(options = {}) {
  const {
    dist = "dist",
    manifest = ".plain/server.mjs",
    port = Number(process.env.PORT) || 3000,
    endpoint = "/_plain/rpc",
  } = options;

  const rpc = rpcMiddleware({ manifest, endpoint });
  const statics = staticMiddleware(dist, { spa: true });

  const server = http.createServer((req, res) => {
    // 顺序很重要：RPC 必须在静态托管/SPA 兜底之前，否则会被吞成 index.html
    const url = (req.url || "").split("?")[0];
    if (url === endpoint) return rpc(req, res);
    statics(req, res);
  });

  await new Promise((r) => server.listen(port, r));
  const addr = server.address();
  const real = typeof addr === "object" && addr ? addr.port : port;
  // eslint-disable-next-line no-console
  console.log(`[plain] http://localhost:${real}  (dist=${path.resolve(dist)})`);
  return server;
}
