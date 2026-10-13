// eval/run.mjs 的 --prompt --context 三档：规则文本从 AGENTS.md 现读现切，
// 切不到会静默变成空上下文 —— 这里守一下，别让「上下文对照」悄悄退化成什么都不给。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = path.join(ROOT, "eval/run.mjs");

/** 跑 `node eval/run.mjs ...` 并返回 stdout */
function run(args) {
  const r = spawnSync(process.execPath, [RUN, ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout || "";
}

test("eval --prompt --context：三档规则上下文都从 AGENTS.md 现读现切", () => {
  const task = run(["--prompt"]);
  assert.ok(!task.includes("Plain 规则上下文"), "默认档只给 task.md");
  assert.match(task, /# 任务 01-counter/);

  const minimal = run(["--prompt", "--context", "minimal"]);
  assert.match(minimal, /Plain 规则上下文（--context minimal）/);
  assert.match(minimal, /## 2\. 只有 5 条规则/);
  assert.match(minimal, /resolve\(props\.x\)/);
  assert.ok(!minimal.includes("反模式目录"), "minimal 不该带反模式目录");

  const full = run(["--prompt", "--context", "full"]);
  assert.match(full, /反模式目录/);
  assert.match(full, /PLAIN_E1106/);
});

test("--context 的值不会被当成任务过滤器", () => {
  const filtered = run(["--prompt", "counter", "--context", "minimal"]);
  assert.match(filtered, /# 任务 01-counter/);
  assert.ok(!filtered.includes("# 任务 02-keyed-list"), "过滤仍然生效");
});
