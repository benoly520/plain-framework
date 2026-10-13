// 服务端清单生成：把编译期识别出的 server() 函数物理落到独立文件

import fs from "node:fs";
import path from "node:path";

export interface ManifestEntry {
  name: string;
  body: string;
  /** 来源模块（绝对路径）。仅用于冲突诊断与去重，不写进产物 */
  from?: string;
}

/**
 * 把入口清单按 `name` 合并前先查重。
 *
 * 为什么必须报错而不是默默覆盖：清单是**一份单文件**（`.plain/server.mjs`），
 * 所有入口 / 所有模块的 server() 都写进同一张表。两个模块各自
 * `const load = server(...)` 时，后者会把前者**静默挤掉** —— 客户端 RPC 桩还在调
 * `load`，服务端却已经换成了另一个实现，是「静默语义降级」里最贵的一种。
 * 这里显式抛错，带上两个来源文件，让作者要么改名、要么就承认是一次冲突。
 */
export function assertNoNameCollision(entries: ManifestEntry[]): void {
  const seen = new Map<string, string>();
  for (const e of entries) {
    const prev = seen.get(e.name);
    if (prev !== undefined) {
      const a = prev || "(未知来源)";
      const b = e.from || "(未知来源)";
      // 同一来源文件重复出现（增量更新把同一条算两遍）不算冲突，跳过。
      // 注意：两边来源都未知时**不**视作同一来源 —— 宁可多报一次冲突，
      // 也不要让一次真正的静默覆盖溜过去（这条规则的唯一目的就是防静默覆盖）。
      if (prev && e.from && prev === e.from) continue;
      throw new Error(
        `[plain] server() 函数名冲突："${e.name}" 在多个模块里被定义：\n` +
          `  - ${a}\n  - ${b}\n` +
          `清单是单文件（.plain/server.mjs），同名会互相覆盖。请把其中一个改名 —— ` +
          `函数名就是 RPC 调用名，必须在整个应用里唯一。`
      );
    }
    seen.set(e.name, e.from || "");
  }
}

/**
 * entries: [{ name, body }] —— body 是函数源码，形如 `async () => {...}`
 */
export function renderServerManifest(entries: ManifestEntry[]): string {
  assertNoNameCollision(entries);
  const lines: string[] = [];
  lines.push("// 由 plain 编译器自动生成：不要手工编辑。");
  lines.push(
    "// 这些函数只在服务端执行；客户端 bundle 里只有 rpc(name, args) 调用桩。"
  );
  lines.push("");
  for (const { name, body } of entries) {
    lines.push(`export const ${name} = ${body};`);
  }
  lines.push("");
  lines.push("export const __plainHandlers = {");
  for (const { name } of entries) lines.push(`  ${name},`);
  lines.push("};");
  lines.push("");
  lines.push(`export async function handle(name, args = []) {
  const fn = __plainHandlers[name];
  if (!fn) throw new Error('unknown server fn: ' + name);
  return await fn(...args);
}`);
  lines.push("");
  return lines.join("\n");
}

export function writeServerManifest(entries: ManifestEntry[], target: string): string {
  const abs = path.resolve(target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, renderServerManifest(entries));
  return abs;
}

/** 渐进式构建：每个源文件只追加/更新自己的 server 函数，不清空整个清单 */
export function updateServerManifest(entries: ManifestEntry[], target: string): string {
  const abs = path.resolve(target);
  const map = new Map<string, ManifestEntry>();
  if (fs.existsSync(abs)) {
    const prev = readManifestEntries(fs.readFileSync(abs, "utf8"));
    prev.forEach((e) => map.set(e.name, e));
  }
  // 同一来源文件的同名函数是「更新」（改代码后重新 transform），不是冲突；
  // 不同来源文件的同名函数才是冲突 —— 交给 assertNoNameCollision 判定。
  for (const e of entries) {
    const prev = map.get(e.name);
    if (prev && prev.from && e.from && prev.from !== e.from) {
      assertNoNameCollision([{ ...prev }, { ...e }]);
    }
    map.set(e.name, e);
  }
  return writeServerManifest(Array.from(map.values()), abs);
}

/** 从 manifest 源码里还原 entries（用于增量更新） */
function readManifestEntries(src: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const re = /^export const ([A-Za-z_$][\w$]*) = ([\s\S]*?);\n(?=export |$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // __plainHandlers 是模板里的固定段，不是用户函数。
    // 必须跳过：否则它会被当成一条 entry 再写一遍，产出重复 const 声明，
    // 让 dev 模式下的 /_plain/rpc 直接加载失败。
    if (m[1] === "__plainHandlers") continue;
    // 来源信息（from）不写进产物，因此从源码还原时拿不回来 —— 增量更新
    // 依赖「清单里已有的名字」即可，来源只在同一轮 transform 里用得上。
    out.push({ name: m[1], body: m[2] });
  }
  return out;
}
