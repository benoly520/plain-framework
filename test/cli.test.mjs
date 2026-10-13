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
