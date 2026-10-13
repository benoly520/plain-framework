// plaindev agent-context —— 把 AGENTS.md 里「给 AI 看的部分」原样吐出来，
// 并可选落地成各家 AI 工具会读的规则文件。
//
// 为什么以 AGENTS.md 为准：它已经是被主流 agent 原生读取的跨工具约定
// （Codex / Cursor / Copilot / Windsurf / Claude Code …），所以「写文件」的第一目标
// 就是项目根目录的 AGENTS.md 本身；.github/copilot-instructions.md 与
// .cursor/rules/*.mdc 是给「只认自家文件」或旧版本的工具兜底。
//
// 内容现读现切而不是内置副本：规则只有一份（AGENTS.md），改了就跟着变，
// 不会出现「文档说 A、注入给 AI 的是 B」。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ContextTarget {
  /** --targets 里用的名字 */
  name: string;
  /** 相对项目根目录的落盘路径 */
  file: string;
  /** 有些格式要自带头部（Cursor 的 .mdc 靠 front-matter 决定「总是生效」） */
  frontMatter?: string;
}

/** 支持的落盘目标；agents 是跨工具标准，另两个是各家的专属文件 */
export const TARGETS: ContextTarget[] = [
  { name: "agents", file: "AGENTS.md" },
  { name: "copilot", file: path.join(".github", "copilot-instructions.md") },
  {
    name: "cursor",
    file: path.join(".cursor", "rules", "plain.mdc"),
    frontMatter:
      "---\n" +
      "description: Plain 框架规则（npx plaindev agent-context 生成）\n" +
      "alwaysApply: true\n" +
      "---\n",
  },
];

/** 默认写全部目标 */
export const DEFAULT_TARGETS = TARGETS.map((t) => t.name);

/** 包内 AGENTS.md 的路径（dist/cli/agent-context.js -> ../../AGENTS.md） */
function agentsPath(): string {
  return fileURLToPath(new URL("../../AGENTS.md", import.meta.url));
}

/**
 * 摘出「写 Plain 应用的人（或 AI）需要的那几节」：第 1–5 节。
 * 第 6 节之后（仓库地图、改动约束、怎么帮框架变好）是给框架维护者的，切掉。
 */
export function contextText(): string {
  const md: string = fs.readFileSync(agentsPath(), "utf8");
  const cut = md.indexOf("\n## 6.");
  const body = cut > 0 ? md.slice(0, cut) : md;
  return (
    "<!-- 由 `npx plaindev agent-context --write` 生成：内容取自 plain 包内的 AGENTS.md，请勿手改 -->\n" +
    body.trimEnd() +
    "\n"
  );
}

/** 解析 --targets 的值；不认识的名字直接抛错（早失败，别悄悄少写一个文件） */
export function parseTargets(value: string): ContextTarget[] {
  const names = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const picked = names.map((n) => {
    const t = TARGETS.find((x) => x.name === n);
    if (!t) {
      throw new Error(
        `未知目标 "${n}"；可选：${TARGETS.map((x) => x.name).join(" / ")}`
      );
    }
    return t;
  });
  return picked.length ? picked : TARGETS;
}

/**
 * 落盘。默认**不覆盖已存在的文件**（项目自己的 AGENTS.md 可能比我们写得好），
 * 想覆盖要显式 --force。返回写了什么、跳过了什么。
 */
export function writeContext(
  dir: string,
  options: { targets?: ContextTarget[]; force?: boolean } = {}
): { written: string[]; skipped: string[] } {
  const targets = options.targets?.length ? options.targets : TARGETS;
  const text = contextText();
  const written: string[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    const abs = path.join(dir, t.file);
    if (fs.existsSync(abs) && !options.force) {
      skipped.push(t.file);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, (t.frontMatter || "") + text);
    written.push(t.file);
  }
  return { written, skipped };
}
