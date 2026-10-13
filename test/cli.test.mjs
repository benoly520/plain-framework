// cli/index.ts 单测：help / check（含 --no-fix / 自动修复 / --warn-only）/ schema（stdout 与 --out）
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist/cli/index.js");

const BAD = [
  "import { signal } from 'plain';",
  "const count = signal(0);",
  "count = count() + 1;",
  "export function App(){ return <p>{count}</p>; }",
  "",
].join("\n");

/** 以子进程方式跑 CLI，返回 { status, stdout, stderr } */
function runCli(args, cwd = ROOT) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "plain-cli-"));
const write = (dir, name, body) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
};

test("help 与无参数都输出用法", () => {
  const a = runCli(["help"]);
  assert.equal(a.status, 0);
  assert.match(a.stdout, /plaindev v\d+\.\d+\.\d+/);
  assert.match(a.stdout, /check/);

  const b = runCli([]);
  assert.equal(b.status, 0);
  assert.match(b.stdout, /plaindev v/);
});

test("未知子命令回落到帮助且退出码为 0", () => {
  const r = runCli(["nope"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /plaindev v/);
});

test("check：干净文件通过，退出码 0", () => {
  const dir = tmpDir();
  write(
    dir,
    "Ok.tsx",
    "import { signal } from 'plain';\nconst n = signal(0);\nexport function App(){ return <p>{n()}</p>; }\n"
  );
  const r = runCli(["check", dir]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /契约检查通过/);
});

test("check --no-fix：报错但不改文件，退出码 1", () => {
  const dir = tmpDir();
  const file = write(dir, "Bad.tsx", BAD);
  const r = runCli(["check", dir, "--no-fix"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /plain\/signal-assign/);
  assert.equal(fs.readFileSync(file, "utf8"), BAD, "文件不应被修改");
});

test("check（默认自动修复）：写回源码", () => {
  const dir = tmpDir();
  const file = write(dir, "Bad.tsx", BAD);
  const r = runCli(["check", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /已自动修复/);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.includes("count.set(count() + 1)"));
  assert.ok(after.includes("{count()}"));
});

test("check --warn-only：有问题也返回 0", () => {
  const dir = tmpDir();
  write(dir, "Bad.tsx", BAD);
  const r = runCli(["check", dir, "--no-fix", "--warn-only"]);
  assert.equal(r.status, 0);
});

test("schema：输出可解析 JSON 契约", () => {
  const dir = tmpDir();
  write(dir, "A.tsx", "export function A(){ return <p>a</p>; }");
  const r = runCli(["schema", dir]);
  assert.equal(r.status, 0);
  const json = JSON.parse(r.stdout);
  assert.equal(json.framework, "plain");
  assert.equal(json.files[0].components[0].name, "A");
});

test("schema --out：写入文件而非 stdout", () => {
  const dir = tmpDir();
  write(dir, "A.tsx", "export function A(){ return <p>a</p>; }");
  const out = path.join(dir, "schema.json");
  const r = runCli(["schema", dir, "--out", out]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /契约已写入/);
  assert.ok(fs.existsSync(out));
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).framework, "plain");
});

test("agent-context：打印给 AI 的精简上下文（内容来自 AGENTS.md）", () => {
  const r = runCli(["agent-context"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /反模式目录/);
  assert.match(r.stdout, /plain\/no-signal-mutate/);
  assert.match(r.stdout, /PLAIN_E1007/);
  // 第 6 节之后是给框架维护者的，不该注入给应用作者
  assert.ok(!r.stdout.includes("仓库地图"), "应切掉维护者章节");
});

test("agent-context --write：落盘 AGENTS.md / copilot / cursor，且不覆盖已有文件", () => {
  const dir = tmpDir();
  const r = runCli(["agent-context", "--write"], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /已写入/);

  // AGENTS.md 是跨工具标准，落盘的第一目标就是它自己
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.match(agents, /反模式目录/);
  assert.match(agents, /plain\/no-signal-mutate/);
  assert.ok(!agents.includes("仓库地图"), "不注入给维护者看的章节");

  const copilot = path.join(dir, ".github", "copilot-instructions.md");
  assert.ok(fs.existsSync(copilot), "应创建 .github 目录");
  assert.match(fs.readFileSync(copilot, "utf8"), /plain\/no-effect-loop/);

  const cursor = path.join(dir, ".cursor", "rules", "plain.mdc");
  assert.match(
    fs.readFileSync(cursor, "utf8"),
    /^---\n[\s\S]*alwaysApply: true[\s\S]*---\n/,
    "Cursor 的 .mdc 要带 front-matter 才会总是生效"
  );

  // 项目自己的 AGENTS.md 不能被悄悄覆盖
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# 我自己的规则");
  const again = runCli(["agent-context", "--write"], dir);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /已存在，未覆盖/);
  assert.equal(
    fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"),
    "# 我自己的规则"
  );

  const forced = runCli(["agent-context", "--write", "--force"], dir);
  assert.equal(forced.status, 0);
  assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /反模式目录/);
});

test("agent-context --targets：只写选中的目标；未知目标报错", () => {
  const dir = tmpDir();
  const r = runCli(["agent-context", dir, "--write", "--targets", "cursor"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, ".cursor", "rules", "plain.mdc")));
  assert.ok(!fs.existsSync(path.join(dir, "AGENTS.md")), "没选 agents 就不该写");
  assert.ok(!fs.existsSync(path.join(dir, ".github")), "没选 copilot 就不该写");

  const bad = runCli(["agent-context", dir, "--write", "--targets", "nope"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /未知目标/);
});

test("check 报出被抑制的行数：抑制不该是隐形的", () => {
  const dir = tmpDir();
  write(
    dir,
    "Ignored.tsx",
    [
      "import { signal } from 'plain';",
      "const count = signal(0);",
      "count = count() + 1; // plain-ignore-line plain/signal-assign",
      "",
    ].join("\n")
  );
  const r = runCli(["check", dir, "--no-fix"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 处抑制指令/);
  assert.ok(
    !r.stdout.includes("plain/signal-assign"),
    "被抑制的规则不该再出现在报告里"
  );
});

test("mcp：initialize / tools/list / tools/call（stdio JSON-RPC）", () => {
  const dir = tmpDir();
  write(dir, "Bad.tsx", BAD);
  const cleanDir = tmpDir();
  write(cleanDir, "Good.tsx", "export function A(){ return <p>ok</p>; }");
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "t" } },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "plain_check", arguments: { target: dir } },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "plain_check", arguments: { target: cleanDir } },
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "nope" },
    },
    { jsonrpc: "2.0", id: 7, method: "whatever" },
  ];
  const input = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const r = spawnSync(process.execPath, [CLI, "mcp"], {
    encoding: "utf8",
    input,
    cwd: ROOT,
  });
  assert.equal(r.status, 0, r.stderr);

  const replies = r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(replies.length, 7, "通知不回包，其余一一对应");

  const [init, list, pong, bad, good, unknown, missing] = replies;
  assert.equal(init.result.serverInfo.name, "plaindev");
  assert.equal(
    init.result.protocolVersion,
    "2025-06-18",
    "客户端给的版本要回 echo，否则握手可能失败"
  );
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ["plain_check", "plain_schema"]
  );
  assert.deepEqual(pong.result, {});
  assert.match(bad.result.content[0].text, /契约检查未通过/);
  assert.match(bad.result.content[0].text, /plain\/signal-assign/);
  assert.equal(bad.result.isError, undefined, "检查没通过不是工具错误");
  assert.match(good.result.content[0].text, /契约检查通过/);
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /未知工具/);
  assert.equal(missing.error.code, -32601);
});
