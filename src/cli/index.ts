#!/usr/bin/env node
// plaindev —— Plain 官方命令行
//
//   plaindev check [dir] [--fix]      契约检查（默认自动修复能修的）
//   plaindev schema [dir] [--out f]   输出机器可读的组件契约
//   plaindev dev   [root]             启动开发服务器（含 RPC）
//   plaindev build [root]             生产构建（含服务端清单剥离）
//   plaindev serve [dist]             生产托管 dist + RPC
//   plaindev agent-context [--write]  给 AI 的规则上下文（落盘 AGENTS.md / copilot / cursor）
//   plaindev mcp                      MCP stdio server：把 check / schema 暴露给 AI IDE

import fs from "node:fs";
import path from "node:path";

import { resolveLocale } from '../diagnostics.js';

const [, , ...tokens] = process.argv;
const args: string[] = [];
const flags = new Set<string>();
const options = new Map<string, string>();
const valueFlags = new Set(['--locale', '--out', '--port', '--out-dir', '--targets']);
let cmd: string | undefined;
for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  if (token.startsWith('--')) {
    const equals = token.indexOf('=');
    const key = equals < 0 ? token : token.slice(0, equals);
    flags.add(key);
    if (equals >= 0) options.set(key, token.slice(equals + 1));
    else if (valueFlags.has(key) && tokens[i + 1] && !tokens[i + 1].startsWith('--')) {
      options.set(key, tokens[++i]);
    }
  } else if (!cmd) cmd = token;
  else args.push(token);
}
const localeOption = options.get('--locale');
let locale = resolveLocale();
try {
  if (flags.has('--locale') && !localeOption) {
    throw new Error(locale === 'zh-CN'
      ? '--locale 需要值：zh-CN、en 或 auto'
      : '--locale requires a value: zh-CN, en, or auto');
  }
  locale = resolveLocale(localeOption);
} catch (error: any) {
  console.error(`[plaindev] ${error.message}`);
  process.exit(1);
}
/** 按当前语言选择外围文案。 */
function text(zh: string, en: string): string {
  return locale === 'zh-CN' ? zh : en;
}

const PKG = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")
);

const HELP = `
plaindev v${PKG.version} —— Plain 框架命令行

  plaindev check [dir] [--no-fix]   契约检查并自动修复高频错误
  plaindev schema [dir] [--out f]   输出组件/server/路由契约 JSON
  plaindev dev [root] [--port n]    开发服务器（含 /_plain/rpc）
  plaindev build [root]             生产构建（生成 .plain/server.mjs）
  plaindev serve [dist] [--port n]  生产托管静态资源 + RPC
  plaindev agent-context [dir] [--write] [--targets a,b] [--force]
                                    打印给 AI 的规则上下文（取自 AGENTS.md）；
                                    --write 落盘到 AGENTS.md / copilot / cursor
                                    （已存在的文件默认不覆盖，--force 才覆盖）
  plaindev mcp                      MCP stdio server：把 check / schema 暴露给 AI IDE
  plaindev lsp                      LSP stdio server：把契约检查接进编辑器实时诊断
  plaindev help                     显示本帮助

  --locale zh-CN|en|auto            选择输出语言（也支持 --locale=en）

提示：dev / build 需要项目里安装了 vite。
`;
const EN_HELP = `
plaindev v${PKG.version} — Plain framework CLI

  plaindev check [dir] [--no-fix]   Check contracts and fix common issues
  plaindev schema [dir] [--out f]   Export component/server/route contracts as JSON
  plaindev dev [root] [--port n]    Start a development server (with /_plain/rpc)
  plaindev build [root]             Build for production (.plain/server.mjs)
  plaindev serve [dist] [--port n]  Serve static files and RPC in production
  plaindev agent-context [dir] [--write] [--targets a,b] [--force]
                                    Print AI context from AGENTS.md; --write writes
                                    AGENTS.md / copilot / cursor files.
                                    Existing files require --force to overwrite.
  plaindev mcp                      Expose check/schema to AI IDEs over MCP stdio
  plaindev lsp                      Provide live contract diagnostics over LSP stdio
  plaindev help                     Show this help

  --locale zh-CN|en|auto            Select output language (also --locale=en)

Tip: dev / build require vite to be installed in the project.
`;

/** 加载命令依赖，失败时显示友好提示。 */
function load(file: string, name: string): Promise<any> {
  return import(new URL(file, import.meta.url).href).catch((e: any) => {
    console.error(text(
      `[plaindev] 加载 ${name} 失败：${e.message}`,
      `[plaindev] Failed to load ${name}: ${e.message}`
    ));
    process.exit(1);
  });
}

function walkFiles(dir: string, exts: RegExp, ignore = /node_modules|\.plain|dist|\.git/): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (ignore.test(p)) continue;
      if (e.isDirectory()) rec(p);
      else if (exts.test(e.name)) out.push(p);
    }
  };
  rec(dir);
  return out;
}

async function cmdCheck(): Promise<number> {
  const { check, autofix, formatIssues, suppressionCount } = await load(
    "../lint.js",
    "lint"
  );
  const dir = args[0] || "src";
  const target = path.resolve(dir);
  const files = fs.statSync(target).isDirectory()
    ? walkFiles(target, /\.(tsx|jsx|ts|js)$/)
    : [target];
  const autoFix = !flags.has("--no-fix");

  let total = 0;
  let fixedCount = 0;
  let suppressedTotal = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const rel = path.relative(process.cwd(), f);
    const issues = check(src, rel);
    // 抑制指令要报出来：它是「确认规则误报」的出口，不该变成隐形的静音开关
    const suppressed = suppressionCount(src);
    suppressedTotal += suppressed;
    if (!issues.length && !suppressed) continue;
    total += issues.length;
    console.log(`\n${rel}`);
    if (issues.length) console.log(formatIssues(issues, rel, locale));
    if (suppressed) {
      console.log(text(
        `  （${suppressed} 处 plain-ignore 抑制：确认是规则误报，而不是绕开规则）`,
        `  (${suppressed} plain-ignore suppressions: confirm false positives, not rule bypasses)`
      ));
    }
    if (autoFix && issues.some((i: any) => i.fix)) {
      const next = autofix(src, issues);
      if (next !== src) {
        fs.writeFileSync(f, next);
        fixedCount++;
        console.log(text(
          `  -> 已自动修复并写回 ${rel}`,
          `  -> Automatically fixed and saved ${rel}`
        ));
      }
    }
  }
  if (!total) {
    console.log(text(
      `[plaindev] 契约检查通过（${files.length} 个文件` +
        (suppressedTotal ? `，${suppressedTotal} 处抑制指令` : '') + '）',
      `[plaindev] Contract checks passed (${files.length} files` +
        (suppressedTotal ? `, ${suppressedTotal} suppressions` : '') + ')'
    ));
    return 0;
  }
  console.log(text(
    `\n[plaindev] 共 ${total} 处问题` +
      `${fixedCount ? `，已修复 ${fixedCount} 个文件` : ''}` +
      `${suppressedTotal ? `，另有 ${suppressedTotal} 处抑制指令` : ''}`,
    `\n[plaindev] ${total} issues found` +
      `${fixedCount ? `, fixed ${fixedCount} files` : ''}` +
      `${suppressedTotal ? `, ${suppressedTotal} additional suppressions` : ''}`
  ));
  return flags.has("--warn-only") ? 0 : 1;
}

async function cmdSchema(): Promise<number> {
  const { scanProject } = await load("../compiler/schema.js", "schema");
  const dir = args[0] || "src";
  const schema = scanProject(path.resolve(dir));
  const json = JSON.stringify(schema, null, 2);
  const out = options.get('--out');
  if (out) {
    fs.writeFileSync(path.resolve(out), json);
    console.log(text(
      `[plaindev] 契约已写入 ${out}`,
      `[plaindev] Contracts written to ${out}`
    ));
  } else {
    console.log(json);
  }
  return 0;
}

async function withVite(): Promise<{ plugin: any; vite: any }> {
  const plugin = (await load("../vite/index.js", "vite plugin")).default;
  let vite: any;
  try {
    vite = await import("vite");
  } catch {
    console.error(text(
      '[plaindev] 需要 vite：pnpm add -D vite',
      '[plaindev] vite is required: pnpm add -D vite'
    ));
    process.exit(1);
  }
  return { plugin, vite };
}

async function cmdDev(): Promise<number> {
  const { plugin, vite } = await withVite();
  const root = path.resolve(args[0] || ".");
  const port = Number(options.get('--port')) || undefined;
  const server = await vite.createServer({
    root,
    configFile: false,
    plugins: [plugin({ locale })],
    clearScreen: false,
    server: port ? { port } : {},
  });
  await server.listen();
  server.printUrls();
  return 0;
}

async function cmdBuild(): Promise<number> {
  const { plugin, vite } = await withVite();
  const root = path.resolve(args[0] || ".");
  await vite.build({
    root,
    configFile: false,
    plugins: [plugin({ locale })],
    build: {
      outDir: options.get('--out-dir') || 'dist',
      emptyOutDir: true,
    },
    logLevel: "info",
  });
  return 0;
}

async function cmdServe(): Promise<number> {
  const { serve } = await load("../server/index.js", "server");
  const dist = args[0] || "dist";
  const port = Number(options.get('--port')) || undefined;
  await serve({ dist, port });
  return 0;
}

/**
 * 打印（或落盘）给 AI 的规则上下文：内容取自 AGENTS.md，不维护第二份副本。
 * 默认目标 = AGENTS.md（跨工具标准）+ copilot / cursor 的专属文件；已存在的文件不覆盖。
 */
async function cmdAgentContext(): Promise<number> {
  const { contextText, parseTargets, writeContext } = await load(
    "./agent-context.js",
    "agent-context"
  );
  const targetValue = options.get('--targets');
  if (!flags.has("--write")) {
    process.stdout.write(contextText());
    return 0;
  }
  // --targets 的值不是位置参数（目录），要排除掉
  const positional = args.filter((a) => a !== targetValue);
  try {
    const targets = targetValue ? parseTargets(targetValue) : undefined;
    const dir = path.resolve(positional[0] || ".");
    const { written, skipped } = writeContext(dir, {
      targets,
      force: flags.has("--force"),
    });
    if (written.length) {
      console.log(`[plaindev] 已写入 ${written.join("、")}（内容取自 AGENTS.md）`);
    }
    for (const s of skipped) {
      console.log(`[plaindev] 已存在，未覆盖：${s}（要覆盖加 --force）`);
    }
    if (!written.length && !skipped.length) {
      console.log("[plaindev] 没有选中任何目标");
    }
    return 0;
  } catch (e: any) {
    console.error(`[plaindev] ${e.message}`);
    return 1;
  }
}

/** MCP stdio server：把 check / schema 暴露成工具，AI IDE 可直连 */
async function cmdMcp(): Promise<number> {
  const { serveStdio } = await load("./mcp.js", "mcp");
  await serveStdio(process.stdin, process.stdout, { locale });
  return 0;
}

/** LSP stdio server：把契约检查接进编辑器，写代码（didOpen/didChange）时就报 */
async function cmdLsp(): Promise<number> {
  const { serveLsp } = await load("./lsp.js", "lsp");
  await serveLsp(process.stdin, process.stdout, { locale: localeOption });
  return 0;
}

const map: Record<string, () => Promise<number>> = {
  check: cmdCheck,
  schema: cmdSchema,
  dev: cmdDev,
  build: cmdBuild,
  serve: cmdServe,
  "agent-context": cmdAgentContext,
  mcp: cmdMcp,
  lsp: cmdLsp,
  help: async () => {
    console.log(locale === 'zh-CN' ? HELP : EN_HELP);
    return 0;
  },
};

const fn = map[cmd || 'help'] || map.help;
try {
  const code = await fn();
  process.exit(code);
} catch (error: any) {
  console.error(text(
    `[plaindev] 命令执行失败：${error.message}`,
    `[plaindev] Command failed: ${error.message}`
  ));
  process.exit(1);
}
