// plaindev lsp —— 把契约检查接进编辑器的**实时诊断**（LSP over stdio）
//
// 为什么不写 tsserver 插件：LSP 是编辑器通用的入口，成本低、收益同构
// （对应 ROADMAP M6 里一直挂着的「仍缺 LSP 实时诊断」）。
// 诊断内容就是 `plaindev check` 的那条规则链 —— 所以**编辑器里报的**与**构建时拦的**
// 是同一套 `PLAIN_Exxxx` 错误码，不会出现两套口径。
//
// 协议只实现最小子集：initialize / initialized / didOpen / didChange / didClose /
// shutdown / exit。文本同步用 Full（每次全量替换）—— 足够，且实现最简单。
// 分帧是 LSP 的 `Content-Length: N\r\n\r\n<json>`（与 MCP 的换行分隔不同）。

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { check } from "../lint.js";
import type { LintIssue } from "../lint.js";

const pkg = (() => {
  try {
    const url = new URL("../../package.json", import.meta.url);
    return JSON.parse(fs.readFileSync(url, "utf8"));
  } catch {
    return { version: "0.0.0" };
  }
})();

/** 只对源码文件出诊断；编辑器打开别的文件（md / json）时给空诊断 */
const SOURCE_EXT = /\.(tsx|jsx|ts|js)$/;

/** file: URI -> 文件路径；不是 file: 或解析失败返回 null */
function fileNameOf(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * 把 lint 问题映射成 LSP 诊断。
 * LintIssue 只有「起点的行 / 列」，没有终点 —— 这里把范围延伸到**行尾**，
 * 语义上等价于「这一行这里有问题」，且客户端高亮可读。
 */
function toDiagnostics(text: string, fileName: string): any[] {
  if (!SOURCE_EXT.test(fileName)) return [];
  const lines = text.split("\n");
  return check(text, fileName).map((i: LintIssue) => {
    const line = Math.max(0, i.line - 1);
    const start = Math.max(0, i.column - 1);
    const lineLen = (lines[line] ?? "").length;
    return {
      range: {
        start: { line, character: start },
        end: { line, character: Math.max(start + 1, lineLen) },
      },
      severity: i.level === "warn" ? 2 : 1,
      code: i.code,
      source: "plain",
      message: i.fix
        ? `${i.message}\n（可自动修：plaindev check --fix）`
        : i.message,
    };
  });
}

/**
 * stdio 主循环。按「收到即顺序处理」的链式调度，保证回包顺序与请求顺序一致。
 * stdin 结束时（或收到 exit 通知）落定；落定前用一次空写做**排空屏障**，
 * 确保诊断已经写进管道再让 CLI `process.exit()`。
 */
export function serveLsp(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout
): Promise<void> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const docs = new Map<string, string>();
    let chain: Promise<void> = Promise.resolve();
    let settled = false;

    const send = (msg: unknown) => {
      const body = Buffer.from(JSON.stringify(msg), "utf8");
      output.write(`Content-Length: ${body.length}\r\n\r\n`);
      output.write(body);
    };
    const notify = (method: string, params: unknown) =>
      send({ jsonrpc: "2.0", method, params });
    const reply = (id: unknown, result: unknown) =>
      send({ jsonrpc: "2.0", id, result });
    const fail = (id: unknown, code: number, message: string) =>
      send({ jsonrpc: "2.0", id, error: { code, message } });

    const done = () => {
      if (settled) return;
      settled = true;
      // 空写回调在之前所有写之后触发 —— 作为排空屏障
      void chain.then(() => output.write("", () => resolve()));
    };

    const publish = (uri: string) => {
      const text = docs.get(uri);
      const file = fileNameOf(uri);
      const diagnostics =
        text === undefined || !file ? [] : toDiagnostics(text, file);
      notify("textDocument/publishDiagnostics", { uri, diagnostics });
    };

    const handle = (msg: any): void => {
      const { id, method, params } = msg || {};
      if (method === "initialize") {
        reply(id, {
          capabilities: { textDocumentSync: 1 }, // 1 = Full
          serverInfo: { name: "plaindev", version: pkg.version },
        });
        return;
      }
      if (method === "initialized") return;
      if (method === "shutdown") {
        reply(id, null);
        return;
      }
      if (method === "exit") {
        done();
        return;
      }
      if (method === "textDocument/didOpen") {
        const uri = params?.textDocument?.uri;
        if (typeof uri === "string") {
          docs.set(uri, String(params?.textDocument?.text ?? ""));
          publish(uri);
        }
        return;
      }
      if (method === "textDocument/didChange") {
        const uri = params?.textDocument?.uri;
        const changes = params?.contentChanges;
        const next = Array.isArray(changes) ? changes[changes.length - 1] : null;
        if (typeof uri === "string" && next && typeof next.text === "string") {
          docs.set(uri, next.text);
          publish(uri);
        }
        return;
      }
      if (method === "textDocument/didClose") {
        const uri = params?.textDocument?.uri;
        if (typeof uri === "string") {
          docs.delete(uri);
          notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
        }
        return;
      }
      // 未实现的方法：请求（有 id）按协议回错，通知（无 id）忽略
      if (id !== undefined) fail(id, -32601, `Method not found: ${String(method)}`);
    };

    input.on("data", (chunk: Buffer | string) => {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      for (;;) {
        const sep = buf.indexOf("\r\n\r\n");
        if (sep < 0) break;
        const header = buf.slice(0, sep).toString("utf8");
        const m = /content-length:\s*(\d+)/i.exec(header);
        if (!m) {
          buf = buf.slice(sep + 4); // 头不合法：丢掉这一帧的头部，继续找下一帧
          continue;
        }
        const len = Number(m[1]);
        const start = sep + 4;
        if (buf.length < start + len) break; // 消息还没收全
        const body = buf.slice(start, start + len).toString("utf8");
        buf = buf.slice(start + len);
        let msg: any;
        try {
          msg = JSON.parse(body);
        } catch {
          continue; // 内容解析不了就当噪声丢掉：协议层不该因一帧坏输入就崩
        }
        chain = chain.then(() => handle(msg));
      }
    });
    input.on("end", done);
  });
}
