// plaindev lsp 单测：Content-Length 分帧 + didOpen/didChange/didClose 的诊断往返
//
// 目的：编辑器里报的诊断必须与构建期拦的是同一套规则链与错误码。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli/index.js");

/** 按 LSP 的 Content-Length 分帧 */
function frame(msg) {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** 解析 LSP 分帧（按字节切，避免非 ASCII 内容被按字符切错） */
function parseFrames(buf) {
  const out = [];
  let rest = Buffer.from(buf);
  for (;;) {
    const sep = rest.indexOf("\r\n\r\n");
    if (sep < 0) break;
    const header = rest.subarray(0, sep).toString("utf8");
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) {
      rest = rest.subarray(sep + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = sep + 4;
    if (rest.length < start + len) break;
    const body = rest.subarray(start, start + len).toString("utf8");
    rest = rest.subarray(start + len);
    try {
      out.push(JSON.parse(body));
    } catch {
      /* 坏帧跳过 */
    }
  }
  return out;
}

const BAD = [
  "import { signal } from 'plain';",
  "const count = signal(0);",
  "count = count() + 1;",
].join("\n");

const GOOD = [
  "import { signal } from 'plain';",
  "const count = signal(0);",
  "export function A(){ return <p>{count()}</p>; }",
].join("\n");

test("lsp：initialize 能力 + didOpen/didChange/didClose 的诊断往返", () => {
  const uri = pathToFileURL(path.join(ROOT, "tmp-lsp-sample.tsx")).href;
  const input = Buffer.from(
    [
      frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } }),
      frame({ jsonrpc: "2.0", method: "initialized", params: {} }),
      frame({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "typescriptreact", version: 1, text: BAD },
        },
      }),
      frame({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: GOOD }] },
      }),
      frame({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri } },
      }),
      frame({ jsonrpc: "2.0", id: 2, method: "shutdown" }),
      frame({ jsonrpc: "2.0", method: "exit" }),
    ].join(""),
    "utf8"
  );

  const r = spawnSync(process.execPath, [CLI, "lsp"], { input, cwd: ROOT });
  assert.equal(r.status, 0, r.stderr && r.stderr.toString());
  const msgs = parseFrames(r.stdout);

  const init = msgs.find((m) => m.id === 1);
  assert.ok(init, "应有 initialize 回包");
  assert.equal(init.result.capabilities.textDocumentSync, 1, "应声明全量文本同步");
  assert.equal(init.result.serverInfo.name, "plaindev");

  const shutdown = msgs.find((m) => m.id === 2);
  assert.ok(shutdown && "result" in shutdown, "shutdown 应回 null result");

  const diags = msgs.filter((m) => m.method === "textDocument/publishDiagnostics");
  assert.equal(diags.length, 3, "didOpen / didChange / didClose 各推一次");

  // didOpen：BAD 源码 -> 1 条 PLAIN_E1101，且带「可自动修」提示
  const opened = diags[0].params.diagnostics;
  assert.equal(opened.length, 1, JSON.stringify(opened));
  assert.equal(opened[0].code, "PLAIN_E1101");
  assert.equal(opened[0].severity, 1, "error -> severity 1");
  assert.equal(opened[0].source, "plain");
  assert.equal(opened[0].range.start.line, 2, "第 3 行（0-based 2）");
  assert.ok(opened[0].message.includes("可自动修"), opened[0].message);

  // didChange 成 GOOD -> 诊断清空
  assert.deepEqual(diags[1].params.diagnostics, []);
  // didClose -> 清空
  assert.deepEqual(diags[2].params.diagnostics, []);
});

test("lsp：非源码文件给空诊断；未知请求回 -32601", () => {
  const uri = pathToFileURL(path.join(ROOT, "tmp-lsp-sample.md")).href;
  const input = Buffer.from(
    [
      frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      frame({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, text: "# 标题" } },
      }),
      frame({ jsonrpc: "2.0", id: 2, method: "workspace/nope", params: {} }),
      frame({ jsonrpc: "2.0", method: "exit" }),
    ].join(""),
    "utf8"
  );
  const r = spawnSync(process.execPath, [CLI, "lsp"], { input, cwd: ROOT });
  assert.equal(r.status, 0, r.stderr && r.stderr.toString());
  const msgs = parseFrames(r.stdout);

  const diags = msgs.find((m) => m.method === "textDocument/publishDiagnostics");
  assert.deepEqual(diags.params.diagnostics, [], "非源码文件不该出诊断");

  const unknown = msgs.find((m) => m.id === 2);
  assert.equal(unknown.error.code, -32601);
});
