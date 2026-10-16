// eval/compare/run.mjs —— Plain vs React 的对称对比
//
// 用法：
//   node eval/compare/run.mjs             跑候选实现（plain.candidate.tsx / react.candidate.jsx）
//   node eval/compare/run.mjs --reference 跑参考实现（自检 harness，不算指标）
//   node eval/compare/run.mjs --prompt    打印共用的提示词（给代理）
//   node eval/compare/run.mjs counter     只跑名字含 counter 的用例
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setupDom } from "../harness.mjs";
import { makePlainApi, makeReactApi } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(HERE, "cases");
const TMP = path.join(HERE, ".tmp");

/** 会吃掉下一个参数的开关（解析位置参数时要跳过它们的值） */
const VALUED_FLAGS = new Set(["--context"]);
const argv = process.argv.slice(2);

const flagValue = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    if (VALUED_FLAGS.has(a)) i++;
    continue;
  }
  positionals.push(a);
}

const promptOnly = argv.includes("--prompt");
const useReference = argv.includes("--reference");
const filter = positionals[0];
// 给代理的规则上下文分三档（与 `eval/tasks/run.mjs` 同口径，见 compare/README.md）：
//   task（默认）只给 task.md；minimal 加 AGENTS.md §1–2；full 再加反模式目录。
//   必须和结果一起记 —— 否则不同档位的数字之间没法比。
const context = flagValue("--context", "task");

const SOURCES = {
  plain: {
    candidate: ["plain.candidate.tsx"],
    reference: ["plain.tsx"],
    make: makePlainApi,
    label: "Plain",
  },
  react: {
    candidate: ["react.candidate.jsx"],
    reference: ["react.jsx"],
    make: makeReactApi,
    label: "React",
  },
};

function caseDirs() {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs
    .readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !filter || n.includes(filter))
    .sort();
}

function pick(dir, kind, side) {
  const names = SOURCES[side][useReference ? "reference" : "candidate"];
  const file = names.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  return file || null;
}

/** 按 `## N.` 分节摘 AGENTS.md（与 eval/tasks/run.mjs 同一套口径，规则只有一份） */
function agentSection(from, to) {
  const md = fs.readFileSync(path.join(HERE, "..", "..", "AGENTS.md"), "utf8");
  const start = md.indexOf(`\n## ${from}.`);
  const end = md.indexOf(`\n## ${to}.`);
  if (start < 0 || end < 0 || end <= start) return "";
  return md.slice(start, end).trim();
}

/** 这次给代理的规则上下文（task 档为空 —— 只给 task.md，与 tasks 侧一致） */
function contextBlock() {
  if (context === "minimal") return agentSection(1, 3); // 简介 + 5 条规则
  if (context === "full") return agentSection(1, 4); // 再加反模式目录
  return "";
}

function printPrompts() {
  const block = contextBlock();
  if (block) {
    console.log(
      `\n${"=".repeat(64)}\n# Plain 规则上下文（--context ${context}）\n${"=".repeat(64)}`
    );
    console.log(block);
  }
  for (const name of caseDirs()) {
    const md = path.join(CASES_DIR, name, "task.md");
    if (!fs.existsSync(md)) continue;
    console.log(`\n${"=".repeat(64)}\n# 用例 ${name}\n${"=".repeat(64)}`);
    console.log(fs.readFileSync(md, "utf8").trim());
  }
  console.log(
    "\n把 Plain 实现写到 `<用例>/plain.candidate.tsx`，React 实现写到 `<用例>/react.candidate.jsx`，" +
      "然后跑 `node eval/compare/run.mjs`。" +
      `\n记录结果时请一并记下上下文档位：--context ${context}（见 compare/README.md）。`
  );
}

async function runSide(name, dir, side) {
  const file = pick(dir, "candidate", side);
  if (!file) return { status: "未提供", file: null };

  try {
    const loaded = await SOURCES[side].make(file);
    const check = (await import(pathToFileURL(path.join(dir, "check.mjs")).href)).default;
    await check(loaded.api);
    return { status: "通过", file };
  } catch (e) {
    const code = typeof e.code === "string" ? e.code : null;
    return {
      status: "失败",
      file,
      reason: String(e.message || e).split("\n")[0],
      // Plain：PLAIN_Exxxx（契约检查 / 编译期）；React：REACT_LINT/<rule>（eslint 闸门）
      blocked: code && (code.startsWith("PLAIN_") || code.startsWith("REACT_LINT/")) ? code : null,
    };
  }
}

async function main() {
  if (promptOnly) return printPrompts();

  setupDom();
  fs.rmSync(TMP, { recursive: true, force: true });

  const names = caseDirs();
  if (!names.length) return console.log("没有找到用例。");

  const rows = [];
  for (const name of names) {
    const dir = path.join(CASES_DIR, name);
    const plain = await runSide(name, dir, "plain");
    const react = await runSide(name, dir, "react");
    rows.push({ name, plain, react });
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `\nPlain vs React 对比（${rows.length} 个用例 · 上下文 ${context}` +
      (useReference ? "，当前跑的是 reference 实现 —— 自检 harness，不算指标" : "") +
      "）"
  );
  console.log("=".repeat(78));
  console.log(`${pad("用例", 24)}${pad("Plain", 10)}${pad("React", 10)}备注`);
  console.log("-".repeat(78));
  for (const r of rows) {
    const note =
      r.plain.status === "失败" && r.react.status === "失败"
        ? `两边都失败：Plain「${r.plain.blocked || r.plain.reason}」/ React「${r.react.reason}」`
        : r.plain.status === "失败"
        ? `Plain 失败：${r.plain.blocked ? `[构建期拦下 ${r.plain.blocked}] ` : ""}${r.plain.reason}`
        : r.react.status === "失败"
        ? `React 失败：${r.react.reason}`
        : "";
    console.log(
      `${pad(r.name, 24)}${pad(r.plain.status, 10)}${pad(r.react.status, 10)}${note}`
    );
  }
  console.log("-".repeat(78));

  const tally = (side) => {
    const done = rows.filter((r) => r[side].status !== "未提供");
    const ok = done.filter((r) => r[side].status === "通过");
    return { done: done.length, ok: ok.length };
  };
  const p = tally("plain");
  const q = tally("react");
  console.log(`已实现用例：Plain ${p.done} / ${rows.length}，React ${q.done} / ${rows.length}`);
  const rate = (t) => (t.done ? `${t.ok} / ${t.done} = ${((t.ok / t.done) * 100).toFixed(0)}%` : "—");
  console.log(`通过率：Plain ${rate(p)}　React ${rate(q)}`);

  const blocked = rows.filter((r) => r.plain.blocked).length;
  const blockedReact = rows.filter((r) => r.react.blocked).length;
  console.log(
    `被构建期拦下：Plain ${blocked} 个（PLAIN_Exxxx）　React ${blockedReact} 个（eslint 规则）` +
      `\n  ↳ 两侧都已接构建期闸门：Plain = 契约检查 + 编译；React = eslint（含 React Compiler 规则集，` +
      `见 eval/compare/eslint.react.config.mjs）。仍不对称之处与已知边界见 README 的公平性说明。`
  );
  console.log(
    `\n把结果记进 eval/RESULTS.md（连同上文档位 \`${context}\` 一起记；见 compare/README.md 的上下文对照）。` +
      `\n改断言要作废重跑 —— 见 eval/compare/README.md 的三条自欺清单。\n`
  );
}

await main();
