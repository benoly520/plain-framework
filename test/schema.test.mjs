// compiler/schema.ts 单测：组件契约 / server 函数 / 路由 / 导入导出 / 目录扫描
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSchema, scanProject } from "../dist/compiler/schema.js";

const comp = (schema, name) => schema.components.find((c) => c.name === name);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "plain-schema-"));

test("函数声明组件：props / 渲染标签 / 行号", () => {
  const s = extractSchema(
    [
      'import { signal } from "plain";',
      "export function Card(props) {",
      '  return <div className="card">{props.title}</div>;',
      "}",
    ].join("\n"),
    "Card.tsx"
  );
  const c = comp(s, "Card");
  assert.ok(c, "应识别出 Card 组件");
  assert.equal(c.line, 2);
  assert.deepEqual(c.renders, ["div"]);
  assert.deepEqual(c.props, [{ name: "title", optional: true }]);
  assert.equal(c.hasChildren, false);
  assert.deepEqual(s.imports, ["plain"]);
  assert.ok(s.exports.includes("Card"));
});

test("箭头函数组件 + children：children 不进 props 但 hasChildren 为真", () => {
  const s = extractSchema(
    [
      "const Page = (props) => (",
      "  <section>{props.children()}</section>",
      ");",
    ].join("\n"),
    "Page.tsx"
  );
  const c = comp(s, "Page");
  assert.ok(c);
  assert.equal(c.hasChildren, true);
  assert.deepEqual(c.props, []);
  assert.deepEqual(c.renders, ["section"]);
});

test("调用点传了属性 -> optional: false", () => {
  const s = extractSchema(
    [
      "function Badge(props) { return <span>{props.text}</span>; }",
      'function App() { return <Badge text="x" tone="warn" />; }',
    ].join("\n"),
    "Badge.tsx"
  );
  const badge = comp(s, "Badge");
  const optional = Object.fromEntries(badge.props.map((p) => [p.name, p.optional]));
  assert.equal(optional.text, false, "调用点传了 text");
  assert.equal(optional.tone, false, "调用点传了 tone");
});

test("解构 props 也能收集到属性名", () => {
  const s = extractSchema(
    "function Foo(props) { const { a, b } = props; return <i>{a}</i>; }",
    "Foo.tsx"
  );
  assert.deepEqual(
    comp(s, "Foo").props.map((p) => p.name).sort(),
    ["a", "b"]
  );
  assert.deepEqual(comp(s, "Foo").renders, ["i"]);
});

test("server() 函数：名称 / 参数 / 是否 async / 行号", () => {
  const s = extractSchema(
    [
      "export const getStats = server(async (id) => {",
      "  return id;",
      "});",
    ].join("\n"),
    "stats.tsx"
  );
  assert.equal(s.serverFunctions.length, 1);
  const f = s.serverFunctions[0];
  assert.equal(f.name, "getStats");
  assert.deepEqual(f.params, ["id"]);
  assert.equal(f.async, true);
  assert.equal(f.line, 1);
});

test("createRouter({ routes }) 提取路由表", () => {
  const s = extractSchema(
    [
      "const router = createRouter({",
      "  routes: [",
      '    { path: "/", component: Home },',
      '    { path: "/u/:id", component: Detail },',
      "  ],",
      "});",
    ].join("\n"),
    "routes.tsx"
  );
  assert.deepEqual(s.routes, [
    { path: "/", component: "Home" },
    { path: "/u/:id", component: "Detail" },
  ]);
});

test("非组件函数不会被当成组件", () => {
  const s = extractSchema("function add(a, b) { return a + b; }", "util.tsx");
  assert.deepEqual(s.components, []);
});

test("scanProject 只收 .tsx/.jsx 且过滤无契约的文件", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "A.tsx"), "export function A(){ return <p>a</p>; }");
  fs.writeFileSync(path.join(dir, "plain.ts"), "export const n = 1;");
  fs.writeFileSync(path.join(dir, "Empty.tsx"), "export const x = 1;");

  const proj = scanProject(dir);
  assert.equal(proj.framework, "plain");
  assert.equal(proj.version, 1);
  assert.equal(proj.files.length, 1, "只有 A.tsx 有契约");
  assert.equal(proj.files[0].components[0].name, "A");
});

test("scanProject 尊重 ignore（node_modules/dist）", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(
    path.join(dir, "node_modules", "B.tsx"),
    "export function B(){ return <p>b</p>; }"
  );
  assert.deepEqual(scanProject(dir).files, []);
});
