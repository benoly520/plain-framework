// eval/run.mjs —— 跑所有评测任务，输出「AI 首次写对率」相关指标
//
// 用法：
//   node eval/run.mjs            跑全部任务
//   node eval/run.mjs counter    只跑名字包含 counter 的任务
//   node eval/run.mjs --prompt   只打印任务提示词（给代理消费）
//   node eval/run.mjs --prompt 01
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCandidate, mountBox, setupDom, tick } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(HERE, "tasks");
const SOURCE_NAMES = {
  candidate: ["candidate.tsx", "candidate.jsx"],
  reference: ["reference.tsx", "reference.jsx"],
};

const argv = process.argv.slice(2);
const promptOnly = argv.includes("--prompt");
const useReference = argv.includes("--reference");
const filter = argv.find((a) => !a.startsWith("--"));
const sourceNames = useReference ? SOURCE_NAMES.reference : SOURCE_NAMES.candidate;

/** 读取任务目录里的 attempts.json（没有就返回 null） */
function readMeta(dir) {
  const f = path.join(dir, "attempts.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function taskDirs() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !filter || n.includes(filter))
    .sort();
}

async function printPrompts() {
  for (const name of taskDirs()) {
    const dir = path.join(TASKS_DIR, name);
    const md = path.join(dir, "task.md");
    if (!fs.existsSync(md)) continue;
    console.log(`\n${"=".repeat(64)}\n# 任务 ${name}\n${"=".repeat(64)}`);
    console.log(fs.readFileSync(md, "utf8").trim());
  }
  console.log(
    "\n把实现写到 `eval/tasks/<任务名>/candidate.tsx`，然后运行 `node eval/run.mjs`。"
  );
}

/** 跑单个任务：加载 candidate → 执行 check.mjs 的断言 */
async function runTask(name) {
  const dir = path.join(TASKS_DIR, name);
  const meta = readMeta(dir);
  const candidate = sourceNames.map((f) => path.join(dir, f)).find((f) =>
    fs.existsSync(f)
  );
  if (!candidate) return { name, status: "未提供", meta };

  try {
    const { mod, code, out } = await loadCandidate(candidate);
    const checkPath = path.join(dir, "check.mjs");
    const check = (await import(pathToFileURL(checkPath).href)).default;
    await check({ mod, code, out, mount: mountBox, tick });
    return { name, status: "通过", meta };
  } catch (e) {
    return {
      name,
      status: "失败",
      reason: String(e.message || e).split("\n")[0],
      // 带 code 的失败 = 在构建期就被拦下了（便宜的错误）
      blockCode: e.code || null,
      meta,
    };
  }
}

async function main() {
  if (promptOnly) return printPrompts();

  setupDom();
  const names = taskDirs();
  if (!names.length) {
    console.log("没有找到任务。");
    return;
  }

  const rows = [];
  for (const name of names) rows.push(await runTask(name));

  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `\nPlain AI 正确率评测（共 ${rows.length} 个任务` +
      (useReference ? "，当前跑的是 reference 实现 —— 用作自检，不算指标" : "") +
      "）"
  );
  console.log("=".repeat(78));
  console.log(`${pad("任务", 30)}${pad("结果", 8)}${pad("轮次", 6)}备注`);
  console.log("-".repeat(78));
  for (const r of rows) {
    const attempts = r.meta && r.meta.attempts ? String(r.meta.attempts) : "-";
    // message 首行已经带了 [PLAIN_E1006] 前缀，这里去掉避免和 blockCode 重复
    const reason = (r.reason || "").replace(/^\[PLAIN_\w+\]\s*/, "");
    const note =
      r.status === "失败"
        ? (r.blockCode ? `[构建期拦下 ${r.blockCode}] ` : "") + reason
        : r.status === "通过" && attempts === "1"
        ? "首次即通过"
        : "";
    console.log(`${pad(r.name, 30)}${pad(r.status, 8)}${pad(attempts, 6)}${note}`);
  }
  console.log("-".repeat(78));

  const provided = rows.filter((r) => r.status !== "未提供");
  const passed = provided.filter((r) => r.status === "通过");
  const withMeta = passed.filter((r) => r.meta && r.meta.attempts);
  const firstTry = withMeta.filter((r) => r.meta.attempts === 1);

  console.log(`已实现任务：${provided.length} / ${rows.length}`);
  if (provided.length) {
    console.log(
      `通过率：${passed.length} / ${provided.length} = ` +
        `${((passed.length / provided.length) * 100).toFixed(0)}%`
    );
  }
  const failed = provided.filter((r) => r.status === "失败");
  if (failed.length) {
    const blocked = failed.filter((r) => r.blockCode);
    console.log(
      `拦截率：${blocked.length} / ${failed.length} = ` +
        `${((blocked.length / failed.length) * 100).toFixed(0)}%` +
        `（失败中被构建期拦下的比例 —— 越高说明错误越便宜）`
    );
  }
  if (withMeta.length) {
    const avg =
      withMeta.reduce((a, r) => a + r.meta.attempts, 0) / withMeta.length;
    console.log(
      `首次通过率：${firstTry.length} / ${withMeta.length} = ` +
        `${((firstTry.length / withMeta.length) * 100).toFixed(0)}%`
    );
    console.log(`平均迭代轮次：${avg.toFixed(2)}`);
  } else {
    console.log(
      "首次通过率 / 平均轮次：需要各任务目录下的 attempts.json（见 eval/README.md）"
    );
  }
  console.log(
    "\n把这次的结果记进 eval/RESULTS.md；同一个任务不要事后改断言（见 eval/README.md）。\n"
  );
}

await main();
