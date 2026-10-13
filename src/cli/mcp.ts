// plaindev mcp —— 把「契约检查 / 契约提取」暴露成 MCP 工具，AI IDE 可直接调用。
//
// 零依赖：MCP 的 stdio 传输就是「一行一个 JSON-RPC 2.0 消息」，
// 这里手写 initialize / tools/list / tools/call 三个方法就够了。
// 目的和 agent-context 一样：让 AI 在写完代码的当场就能拿到反馈，
// 而不是等人类跑一次构建。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "2024-11-05";
const IGNORE = /node_modules|\.plain|dist|\.git|coverage/;

const pkg = (() => {
  try {
    const url = new URL("../../package.json", import.meta.url);
    return JSON.parse(fs.readFileSync(url, "utf8"));
  } catch {
    return { version: "0.0.0" };
  }
})();

export const TOOLS = [
  {
    name: "plain_check",
    description:
      "对 Plain 源码运行构建期契约检查（与 vite 插件同一条规则链），返回规则码、行列与修法。",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "文件或目录路径，默认 src（相对当前工作目录）",
        },
      },
    },
  },
  {
    name: "plain_schema",
    description: "提取 Plain 项目的组件 / server / 路由契约 JSON。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "目录路径，默认 src" },
      },
    },
  },
];

/** 递归收集源码文件（与 plaindev check 同口径） */
function collectFiles(target: string): string[] {
  const exts = /\.(tsx|jsx|ts|js)$/;
  if (!fs.statSync(target).isDirectory()) return [target];
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (IGNORE.test(p)) continue;
      if (e.isDirectory()) rec(p);
      else if (exts.test(e.name)) out.push(p);
    }
  };
  rec(target);
  return out;
}

/** 执行一个工具，返回给模型看的纯文本 */
async function callTool(name: unknown, args: any): Promise<string> {
  const target = path.resolve(args?.target || "src");

  if (name === "plain_check") {
    const { check, formatIssues } = await import("../lint.js");
    const files = collectFiles(target);
    const blocks: string[] = [];
    let total = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      const rel = path.relative(process.cwd(), f);
      const issues = check(src, rel);
      if (!issues.length) continue;
      total += issues.length;
      blocks.push(`${rel}\n${formatIssues(issues, rel)}`);
    }
    return total
      ? `契约检查未通过：共 ${total} 处问题\n\n${blocks.join("\n\n")}`
      : `契约检查通过（${files.length} 个文件）`;
  }

  if (name === "plain_schema") {
    const { scanProject } = await import("../compiler/schema.js");
    return JSON.stringify(scanProject(target), null, 2);
  }

  throw new Error(`未知工具：${String(name)}`);
}

/** 处理一行 JSON-RPC；通知不回复 */
async function handleLine(line: string, output: NodeJS.WriteStream): Promise<void> {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 解析不了的当噪声丢掉：协议层不该因为一行坏输入就崩
  }
  const { id, method, params } = msg || {};
  const reply = (result: unknown) =>
    output.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const fail = (code: number, message: string) =>
    output.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
    );

  try {
    if (method === "initialize") {
      reply({
        protocolVersion:
          typeof params?.protocolVersion === "string"
            ? params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "plaindev", version: pkg.version },
      });
    } else if (method === "notifications/initialized" || method === "initialized") {
      return; // 通知，无 id，不回
    } else if (method === "tools/list") {
      reply({ tools: TOOLS });
    } else if (method === "tools/call") {
      try {
        const text = await callTool(params?.name, params?.arguments);
        reply({ content: [{ type: "text", text }] });
      } catch (e: any) {
        // 工具自身报错也要按协议回，让模型看到原因
        reply({
          content: [{ type: "text", text: String(e?.message || e) }],
          isError: true,
        });
      }
    } else if (method === "ping") {
      reply({});
    } else if (id !== undefined) {
      fail(-32601, `Method not found: ${String(method)}`);
    }
  } catch (e: any) {
    if (id !== undefined) fail(-32603, String(e?.message || e));
  }
}

/**
 * stdio 主循环：逐行读、按顺序处理，stdin 结束时返回。
 * 严格顺序（不并发）才能保证「回包顺序 = 请求顺序」，客户端才好对。
 */
export function serveStdio(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout
): Promise<void> {
  return new Promise((resolve) => {
    let buf = "";
    let chain: Promise<void> = Promise.resolve();
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) chain = chain.then(() => handleLine(line, output));
      }
    });
    input.on("end", () => {
      void chain.then(resolve);
    });
  });
}
