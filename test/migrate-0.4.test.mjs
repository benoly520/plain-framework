// 0.3 → 0.4 codemod 回归测试
//
// 钉住的不变量：
// 1. 只改从 `plain` 导入的 `resolve`，别误伤同名本地函数 / 别名导入；
// 2. `children` 仍是 lazy thunk，必须保留一次调用；
// 3. 类型收缩与 JSX 箭头改写都是幂等的，重复跑不会二次改写。

import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateSource } from "../scripts/migrate-0.3-to-0.4.mjs";

/** 构造迁移选项（测试默认关闭代码示例，专注 AST 改写）。 */
function options(overrides = {}) {
  return {
    targets: [],
    dryRun: true,
    valueProps: new Set(["open", "value", "current", "data", "target", "to"]),
    codeSamples: false,
    quiet: true,
    ...overrides,
  };
}

/** 迁移一段源码。 */
function migrate(source, overrides) {
  return migrateSource(source, "fixture.tsx", options(overrides));
}

test("删除 plain 的 resolve 导入并直接读 props", () => {
  const source = [
    "import { signal, resolve } from 'plain';",
    "",
    "function Card(props) {",
    "  const t = () => resolve(props.title);",
    "  return <h2>{resolve(props.title)}</h2>;",
    "}",
  ].join("\n");
  const result = migrate(source);
  assert.equal(result.skipped, false);
  assert.match(result.text, /import \{ signal \} from 'plain';/);
  assert.match(result.text, /const t = \(\) => props\.title;/);
  assert.match(result.text, /<h2>\{props\.title\}<\/h2>/);
  assert.doesNotMatch(result.text, /\bresolve\b/);
});

test("resolve 是唯一 import 时整行删除，并清掉首行空行", () => {
  const source = [
    "import { resolve } from 'plain';",
    "",
    "export const view = <p>{resolve(props.text)}</p>;",
  ].join("\n");
  const result = migrate(source);
  assert.match(result.text, /^export const view = <p>\{props\.text\}<\/p>;/);
  assert.doesNotMatch(result.text, /\bresolve\b|\bimport\b/);
});

test("children 保留 lazy thunk：加一次调用（含链式访问）", () => {
  const source = [
    "import { resolve } from 'plain';",
    "const a = resolve(props.children);",
    "const b = resolve(props['children']);",
    "const c = () => resolve(props.children);",
  ].join("\n");
  const result = migrate(source);
  assert.match(result.text, /const a = props\.children\?\.\(\);/);
  assert.match(result.text, /const b = props\.children\?\.\(\);/);
  assert.match(result.text, /const c = \(\) => props\.children\?\.\(\);/);
});

test("MaybeGetter<T> 收缩为 T，children 收缩为 () => T", () => {
  const source = [
    "import type { MaybeGetter, Renderable } from './_shared';",
    "",
    "type CardProps = {",
    "  title?: MaybeGetter<string>;",
    "  items?: MaybeGetter<string>[];",
    "  children?: MaybeGetter<Renderable>;",
    "};",
  ].join("\n");
  const result = migrate(source);
  assert.match(result.text, /import type \{ Renderable \} from '\.\/_shared';/);
  assert.match(result.text, /title\?: string;/);
  assert.match(result.text, /items\?: string\[\];/);
  assert.match(result.text, /children\?: \(\) => Renderable;/);
  assert.doesNotMatch(result.text, /MaybeGetter/);
});

test("Renderable | (() => Renderable) 收缩，children 保留函数形态", () => {
  const source = [
    "type A = {",
    "  icon?: Renderable | (() => Renderable);",
    "  children?: Renderable | (() => Renderable);",
    "};",
  ].join("\n");
  const result = migrate(source);
  assert.match(result.text, /icon\?: Renderable;/);
  assert.match(result.text, /children\?: \(\) => Renderable;/);
});

test("原生元素上的零参箭头属性改成直接表达式", () => {
  const source = [
    "const view = (",
    "  <input value={() => name()} title={() => title()} class={() => cls()} />",
    ");",
  ].join("\n");
  const result = migrate(source);
  assert.match(result.text, /value=\{name\(\)\}/);
  assert.match(result.text, /title=\{title\(\)\}/);
  assert.match(result.text, /class=\{cls\(\)\}/);
});

test("组件属性只改名单内名字，其余留给人工确认", () => {
  const source = [
    "const view = (",
    "  <Dialog open={() => open()} foo={() => bar()} render={() => node} />",
    ");",
  ].join("\n");
  const result = migrate(source);
  assert.match(result.text, /open=\{open\(\)\}/);
  assert.match(result.text, /foo=\{\(\) => bar\(\)\}/);
  assert.match(result.text, /render=\{\(\) => node\}/);
  assert.ok(result.warnings.some((w) => w.kind === "jsx-arrow" && w.detail.includes("的 foo=")));
  assert.ok(!result.warnings.some((w) => w.kind === "jsx-arrow" && w.detail.includes("的 render=")));
});

test("清理失效的 PLAIN_E1108 抑制指令，保留其它规则", () => {
  const source = [
    "const t = props.title; // plain-ignore-line PLAIN_E1108",
    "const u = props.count; // plain-ignore-line PLAIN_E1108 PLAIN_E1112",
    "const v = props.extra; // plain-ignore-line PLAIN_E1108 已知误报",
  ].join("\n");
  const result = migrate(source);
  assert.match(result.text, /^const t = props\.title;$/m);
  assert.match(result.text, /const u = props\.count; \/\/ plain-ignore-line PLAIN_E1112/);
  assert.match(result.text, /^const v = props\.extra;$/m);
});

test("同名本地 resolve 不受影响", () => {
  const source = [
    "import { resolve } from 'node:path';",
    "const p = resolve(foo);",
  ].join("\n");
  const result = migrate(source);
  assert.equal(result.text, source);
});

test("嵌套 resolve 与复杂参数仍能收敛", () => {
  const source = [
    "import { resolve } from 'plain';",
    "const a = resolve(resolve(props.x));",
    "const b = resolve(flag || fallback);",
  ].join("\n");
  const result = migrate(source);
  assert.match(result.text, /const a = props\.x;/);
  assert.match(result.text, /const b = \(flag \|\| fallback\);/);
});

test("重复执行是幂等的", () => {
  const source = [
    "import { resolve } from 'plain';",
    "",
    "type P = { children?: MaybeGetter<Renderable>; icon?: Renderable | (() => Renderable) };",
    "const view = <input value={() => name()} />;",
  ].join("\n");
  const first = migrate(source);
  const second = migrate(first.text);
  assert.equal(second.text, first.text);
  assert.equal(second.changes.length, 0);
});

test("--code-samples 只改看起来像 JSX 的字符串", () => {
  const source = [
    "const a = '<Input value={() => v()} title={() => t()} />';",
    "const b = '普通文案，不包含 JSX';",
  ].join("\n");
  const result = migrate(source, { codeSamples: true });
  assert.match(result.text, /const a = '<Input value=\{v\(\)\} title=\{t\(\)\} \/>';/);
  assert.match(result.text, /const b = '普通文案，不包含 JSX';/);
});

test("别名导入 resolve 不自动改，给出告警", () => {
  const source = [
    "import { resolve as r } from 'plain';",
    "const v = r(props.x);",
  ].join("\n");
  const result = migrate(source);
  assert.equal(result.text, source);
  assert.ok(result.warnings.some((w) => w.kind === "resolve-alias"));
});

test("语法解析失败时跳过文件，不写坏源码", () => {
  const source = "const x = ;";
  const result = migrate(source);
  assert.equal(result.skipped, true);
  assert.equal(result.text, source);
  assert.equal(result.warnings[0].kind, "parse-error");
});
