#!/usr/bin/env node
// create-plain —— Plain 官方脚手架
//
// 用法：
//   create-plain [项目名] [--template minimal] [--name 项目名]
//   npx create-plain my-app
//
// 行为：复制内置模板到目标目录，并把模板里的 __PROJECT_NAME__ 占位符
//       替换成项目名。不自动安装依赖、不自动 git init（交给用户决定）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, "template");

/**
 * 递归复制模板目录，并将 __PROJECT_NAME__ 占位符替换为项目名
 * @param {string} src 源目录
 * @param {string} dest 目标目录
 * @param {string} projectName 项目名
 */
function copyTemplate(src, dest, projectName) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTemplate(from, to, projectName);
    } else {
      const raw = fs.readFileSync(from, "utf8");
      const replaced = raw.replace(/__PROJECT_NAME__/g, projectName);
      fs.writeFileSync(to, replaced);
    }
  }
}

/**
 * 解析命令行参数
 * @param {string[]} argv process.argv 去掉前两项后的部分
 * @returns {{ name: string, template: string }}
 */
function parseArgs(argv) {
  const opts = { name: "my-plain-app", template: "minimal" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--template" || a === "-t") {
      opts.template = argv[++i] ?? opts.template;
    } else if (a === "--name" || a === "-n") {
      opts.name = argv[++i] ?? opts.name;
    } else if (!a.startsWith("-")) {
      opts.name = a;
    }
  }
  return opts;
}

/**
 * 入口：创建项目，失败时打印友好错误并以非零码退出
 */
function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.name || opts.name.startsWith("-")) {
      throw new Error("缺少项目名，用法：create-plain <项目名>");
    }

    const targetDir = path.resolve(process.cwd(), opts.name);
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
      throw new Error(`目标目录已存在且非空：${targetDir}`);
    }

    // 占位符替换用目录名（basename），保证 package.json 的 name 是合法包名
    const projectName = path.basename(targetDir);
    fs.mkdirSync(targetDir, { recursive: true });
    copyTemplate(TEMPLATE_DIR, targetDir, projectName);

    console.log(`\n✓ 已创建 Plain 项目：${targetDir}\n`);
    console.log("下一步：");
    console.log(`  cd ${opts.name}`);
    console.log("  npm install   # 或 pnpm install");
    console.log("  npm run dev\n");
  } catch (err) {
    console.error(`\n✗ create-plain 失败：${err.message}\n`);
    process.exit(1);
  }
}

main();
