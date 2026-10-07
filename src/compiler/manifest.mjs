// 服务端清单生成：把编译期识别出的 server() 函数物理落到独立文件

import fs from "node:fs";
import path from "node:path";

/**
 * entries: [{ name, body }] —— body 是函数源码，形如 `async () => {...}`
 */
export function renderServerManifest(entries) {
  const lines = [];
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

export function writeServerManifest(entries, target) {
  const abs = path.resolve(target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, renderServerManifest(entries));
  return abs;
}

/** 渐进式构建：每个源文件只追加/更新自己的 server 函数，不清空整个清单 */
export function updateServerManifest(entries, target) {
  const abs = path.resolve(target);
  const map = new Map();
  if (fs.existsSync(abs)) {
    const prev = readManifestEntries(fs.readFileSync(abs, "utf8"));
    prev.forEach((e) => map.set(e.name, e.body));
  }
  entries.forEach((e) => map.set(e.name, e.body));
  return writeServerManifest(
    Array.from(map, ([name, body]) => ({ name, body })),
    abs
  );
}

/** 从 manifest 源码里还原 entries（用于增量更新） */
function readManifestEntries(src) {
  const out = [];
  const re = /^export const ([A-Za-z_$][\w$]*) = ([\s\S]*?);\n(?=export |$)/gm;
  let m;
  while ((m = re.exec(src))) out.push({ name: m[1], body: m[2] });
  return out;
}
