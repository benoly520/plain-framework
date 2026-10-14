// JSX 类型收紧的类型级测试：用真的 tsc 跑一遍，钉住「拼写/类型错要报、合法写法不报」
//
// 为什么值得单独测：这次收紧的是**类型**，运行时的单测完全覆盖不到它 ——
// 一旦有人在 CommonAttributes 里把 `[attr: string]: any` 加回来，所有运行时测试照样全绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSC = path.join(ROOT, "node_modules", "typescript", "lib", "tsc.js");

/** 在临时目录里用真 tsc 检查若干文件；返回 tsc 的合并输出 */
function runTsc(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plain-types-"));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          jsx: "preserve",
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: [],
          skipLibCheck: true,
          baseUrl: ROOT,
          paths: { plain: ["dist/index.d.ts"] },
        },
        files: Object.keys(files),
      },
      null,
      2
    )
  );
  const r = spawnSync(process.execPath, [TSC, "-p", dir], { encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}

/** 从 tsc 输出里取出「哪些行报错了」 */
function errorLines(out, file) {
  const re = new RegExp(
    `${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\((\\d+),\\d+\\): error`,
    "g"
  );
  return [...new Set([...out.matchAll(re)].map((m) => Number(m[1])))].sort(
    (a, b) => a - b
  );
}

test("JSX 类型收紧：属性名拼错 / 类型写错当场报，合法写法不报", () => {
  // 行号即断言的一部分，改动本 fixture 请同步更新期望值
  const src = [
    `import { signal } from "plain";`, // 1
    `export function A() {`, // 2
    `  const n = signal(0);`, // 3
    `  return (`, // 4
    `    <div`, // 5
    `      className="ok"`, // 6
    `      role="button"`, // 7
    `      aria-label="x"`, // 8
    `      data-id={1}`, // 9
    `      tabIndex={0}`, // 10
    `      onClick={() => n.set(n() + 1)}`, // 11
    `      colSpan={2}`, // 12  共用属性不区分元素 -> 不报
    `    >`, // 13
    `      <img src="/a.png" alt="a" width={10} />`, // 14
    `      <img scr="/b.png" />`, // 15  报：属性名拼错
    `      <input checked="yes" />`, // 16  报：应为布尔
    `      <input value={n()} onInput={(e) => e.target.value} />`, // 17
    `      <my-widget foo="bar" />`, // 18  未知标签放行
    `      <div onClikc={() => {}} />`, // 19  报：事件名拼错
    `      <canvas ref={(el) => { el.getContext("2d"); }} />`, // 20
    `      <div>文本</div>`, // 21
    `    </div>`, // 22
    `  );`, // 23
    `}`, // 24
  ].join("\n");

  const out = runTsc({ "case.tsx": src });
  assert.deepEqual(
    errorLines(out, "case.tsx"),
    [15, 16, 19],
    "只该在第 15 / 16 / 19 行报错（拼错的属性名、写错的类型、拼错的事件名）：\n" + out
  );
});

test("JSX 类型收紧：组件 props 仍然按组件自己的类型校验", () => {
  const src = [
    `type CardProps = { title: string; count?: number };`, // 1
    `function Card(props: CardProps) {`, // 2
    `  return <section>{props.title}</section>;`, // 3  props.title 合法（编译器传 getter，类型上做了 MaybeGetter 兼容？这里直接字符串）
    `}`, // 4
    `export function A() {`, // 5
    `  return (`, // 6
    `    <div>`, // 7
    `      <Card title="ok" count={1} />`, // 8  合法
    `      <Card typo={1} />`, // 9   报：未声明的 prop
    `      <Card />`, // 10  报：缺必填 title
    `    </div>`, // 11
    `  );`, // 12
    `}`, // 13
  ].join("\n");

  const out = runTsc({ "comp.tsx": src });
  const lines = errorLines(out, "comp.tsx");
  assert.ok(lines.includes(9), "未声明的 prop 应报错：\n" + out);
  assert.ok(lines.includes(10), "缺必填 prop 应报错：\n" + out);
  assert.ok(!lines.includes(8), "合法调用不该报错：\n" + out);
});
