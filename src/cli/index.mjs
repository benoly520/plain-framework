#!/usr/bin/env node
// plaindev —— Plain 官方命令行
//
//   plaindev check [dir] [--fix]     契约检查（默认自动修复能修的）
//   plaindev schema [dir] [--out f]  输出机器可读的组件契约
//   plaindev dev   [root]            启动开发服务器（含 RPC）
//   plaindev build [root]            生产构建（含服务端清单剥离）
//   plaindev serve [dist]            生产托管 dist + RPC

import fs from "node:fs";
import path from "node:path";

const [, , cmd, ...rest] = process.argv;
const args = rest.filter((a) => !a.startsWith("--"));
const flags = new Set(rest.filter((a) => a.startsWith("--")));

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
  plaindev help                     显示本帮助

提示：dev / build 需要项目里安装了 vite。
`;

function load(file, name) {
  return import(new URL(file, import.meta.url).href).catch((e) => {
    console.error(`[plaindev] 加载 ${name} 失败：${e.message}`);
    process.exit(1);
  });
}

function walkFiles(dir, exts, ignore = /node_modules|\.plain|dist|\.git/) {
  const out = [];
  const rec = (d) => {
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

async function cmdCheck() {
  const { check, autofix, formatIssues } = await load("../lint.mjs", "lint");
  const dir = args[0] || "src";
  const target = path.resolve(dir);
  const files = fs.statSync(target).isDirectory()
    ? walkFiles(target, /\.(tsx|jsx|ts|js)$/)
    : [target];
  const autoFix = !flags.has("--no-fix");

  let total = 0;
  let fixedCount = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const rel = path.relative(process.cwd(), f);
    const issues = check(src, rel);
    if (!issues.length) continue;
    total += issues.length;
    console.log(`\n${rel}`);
    console.log(formatIssues(issues, rel));
    if (autoFix && issues.some((i) => i.fix)) {
      const next = autofix(src, issues);
      if (next !== src) {
        fs.writeFileSync(f, next);
        fixedCount++;
        console.log(`  -> 已自动修复并写回 ${rel}`);
      }
    }
  }
  if (!total) {
    console.log(`[plaindev] 契约检查通过（${files.length} 个文件）`);
    return 0;
  }
  console.log(
    `\n[plaindev] 共 ${total} 处问题${fixedCount ? `，已修复 ${fixedCount} 个文件` : ""}`
  );
  return flags.has("--warn-only") ? 0 : 1;
}

async function cmdSchema() {
  const { scanProject } = await load("../compiler/schema.mjs", "schema");
  const dir = args[0] || "src";
  const schema = scanProject(path.resolve(dir));
  const json = JSON.stringify(schema, null, 2);
  const out = (() => {
    const i = rest.indexOf("--out");
    return i >= 0 ? rest[i + 1] : null;
  })();
  if (out) {
    fs.writeFileSync(path.resolve(out), json);
    console.log(`[plaindev] 契约已写入 ${out}`);
  } else {
    console.log(json);
  }
  return 0;
}

async function withVite() {
  const plugin = (await load("../vite/index.mjs", "vite plugin")).default;
  let vite;
  try {
    vite = await import("vite");
  } catch {
    console.error("[plaindev] 需要 vite：pnpm add -D vite");
    process.exit(1);
  }
  return { plugin, vite };
}

async function cmdDev() {
  const { plugin, vite } = await withVite();
  const root = path.resolve(args[0] || ".");
  const port = Number((() => {
    const i = rest.indexOf("--port");
    return i >= 0 ? rest[i + 1] : null;
  })()) || undefined;
  const server = await vite.createServer({
    root,
    configFile: false,
    plugins: [plugin()],
    clearScreen: false,
    server: port ? { port } : {},
  });
  await server.listen();
  server.printUrls();
  return 0;
}

async function cmdBuild() {
  const { plugin, vite } = await withVite();
  const root = path.resolve(args[0] || ".");
  await vite.build({
    root,
    configFile: false,
    plugins: [plugin()],
    build: {
      outDir: (() => {
        const i = rest.indexOf("--out-dir");
        return i >= 0 ? rest[i + 1] : "dist";
      })(),
      emptyOutDir: true,
    },
    logLevel: "info",
  });
  return 0;
}

async function cmdServe() {
  const { serve } = await load("../server/index.mjs", "server");
  const dist = args[0] || "dist";
  const portIdx = rest.indexOf("--port");
  const port = portIdx >= 0 ? Number(rest[portIdx + 1]) : undefined;
  await serve({ dist, port });
  return 0;
}

const map = {
  check: cmdCheck,
  schema: cmdSchema,
  dev: cmdDev,
  build: cmdBuild,
  serve: cmdServe,
  help: async () => {
    console.log(HELP);
    return 0;
  },
};

const fn = map[cmd] || map.help;
if (!cmd) console.log(HELP);
const code = await fn();
process.exit(code);
