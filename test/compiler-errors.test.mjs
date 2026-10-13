// 编译器结构化错误：错误码 / 文件 / 行列 / hint，以及可被 JSON 序列化
import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, PlainCompileError } from "../dist/compiler/index.js";

/** 捕获 compile 抛出的错误 */
function catchCompile(source, fileName) {
  try {
    compile(source, fileName);
  } catch (e) {
    return e;
  }
  return assert.fail("应当抛出 PlainCompileError");
}

test("PLAIN_E1001：不认识的 JSX 位置，带位置与修正提示", () => {
  const err = catchCompile(
    ["const x = <p>hi</p>;", "export function App(){ return <i/>; }"].join("\n"),
    "bad.jsx"
  );
  assert.ok(err instanceof PlainCompileError);
  assert.equal(err.name, "PlainCompileError");
  assert.equal(err.code, "PLAIN_E1001");
  assert.equal(err.file, "bad.jsx");
  assert.equal(err.line, 1);
  assert.equal(err.column, 11, "指向 <p> 的起始列");
  assert.match(err.hint, /arr\.map/);
  assert.match(err.message, /^\[PLAIN_E1001\] bad\.jsx:1:11 /);
  assert.match(err.message, /提示：/);
});

test("PLAIN_E1002：产物无法解析时给出诊断与输入要求", () => {
  const err = catchCompile(
    ["const z: = 1;", "export function App(){ return <p>{z}</p>; }"].join("\n"),
    "ts.jsx"
  );
  assert.equal(err.code, "PLAIN_E1002");
  assert.equal(err.file, "ts.jsx");
  assert.match(err.detail, /无法解析/);
  assert.match(err.hint, /jsx: 'preserve'/);
});

test("PLAIN_E1005：key 与 index 同时使用（不再静默丢掉其中一个）", () => {
  const err = catchCompile(
    [
      "export function App(){",
      '  return <ul>{items.map((it, i) => <li key={it.id}>{i}</li>)}</ul>;',
      "}",
    ].join("\n"),
    "key.jsx"
  );
  assert.equal(err.code, "PLAIN_E1005");
  assert.equal(err.file, "key.jsx");
  assert.equal(err.line, 2);
  assert.match(err.detail, /不能同时使用/);
  assert.match(err.hint, /二者选一/);
});

test("PLAIN_E1006：server() 引用模块作用域变量 / import / 闭包参数", () => {
  const cases = [
    [
      "模块作用域 const",
      ["const secret = 1;", "export const f = server(async () => secret);"].join("\n"),
      "secret",
    ],
    [
      "import 绑定",
      ['import { db } from "./db.js";', "export const f = server(async () => db.q());"].join("\n"),
      "db",
    ],
    [
      "外层函数参数（闭包）",
      "export function make(db) { return server(async () => db.q()); }",
      "db",
    ],
    [
      "普通模块函数",
      ["function helper(){}", "export const f = server(async () => helper());"].join("\n"),
      "helper",
    ],
  ];
  for (const [label, src, leaked] of cases) {
    const err = catchCompile(src, "s.jsx");
    assert.equal(err.code, "PLAIN_E1006", label);
    assert.equal(err.file, "s.jsx", label);
    assert.match(err.detail, new RegExp(leaked), label);
    assert.match(err.hint, /闭包不会跟过去/, label);
  }
});

test("PLAIN_E1006 不误报：局部 / 参数 / 全局 / 其它 server 函数 / 属性名 / 动态 import", () => {
  const ok = [
    "export const f = server(async () => { const x = 1; return x; });",
    "export const f = server(async (n) => n * 2);",
    'export const f = server(async () => ({ a: Math.floor(1), b: process.env.X, c: JSON.stringify({}) }));',
    "const a = server(async () => 1);\nconst b = server(async () => a());",
    "export const f = server(async () => f());",
    'const name = 1;\nexport const f = server(async () => ({ name: "x" }));',
    'export const f = server(async () => import("./db.js"));',
    "export const f = server(async ({ id }) => id);",
  ];
  for (const src of ok) {
    assert.doesNotThrow(() => compile(src, "ok.jsx"), src);
  }
});

test("错误可 JSON 序列化，便于 CI / AI 直接消费", () => {
  const err = catchCompile("const x = <p/>;", "a.jsx");
  const json = JSON.parse(JSON.stringify(err));
  assert.equal(json.name, "PlainCompileError");
  assert.equal(json.code, "PLAIN_E1001");
  assert.equal(json.file, "a.jsx");
  assert.equal(json.line, 1);
  assert.equal(typeof json.column, "number");
  assert.equal(typeof json.hint, "string");
});

test("PLAIN_E1007：给 server() 传函数 / 本文件类实例 / Stream", () => {
  const cases = [
    [
      "内联函数",
      [
        "export const f = server(async (fn) => fn());",
        "f(() => 1);",
      ].join("\n"),
      "函数",
    ],
    [
      "本文件的校验函数",
      [
        "function validate(u) { return u; }",
        "export const createUser = server(async (user, v) => v(user));",
        "createUser({ name: 'a' }, validate);",
      ].join("\n"),
      "validate",
    ],
    [
      "对象里夹函数",
      [
        "export const f = server(async (x) => x);",
        "f({ ok: true, check: (n) => n > 0 });",
      ].join("\n"),
      "函数",
    ],
    [
      "本文件 class 实例",
      [
        "class User { constructor(n) { this.n = n; } }",
        "export const f = server(async (u) => u);",
        "f(new User('a'));",
      ].join("\n"),
      "User",
    ],
    [
      "ReadableStream",
      [
        "export const f = server(async (s) => s);",
        "f(new ReadableStream());",
      ].join("\n"),
      "ReadableStream",
    ],
    [
      "立即调用 server()(fn)",
      "server(async (fn) => fn())(() => 1);",
      "函数",
    ],
  ];
  for (const [label, src, hint] of cases) {
    const err = catchCompile(src, "s.jsx");
    assert.equal(err.code, "PLAIN_E1007", label);
    assert.equal(err.file, "s.jsx", label);
    assert.match(err.detail, new RegExp(hint), label);
    assert.match(err.hint, /不要传 \/ 返回函数/, label);
  }
});

test("PLAIN_E1007：server() 的返回值也要能 JSON 序列化", () => {
  const cases = [
    [
      "简洁体返回函数",
      "export const f = server(() => () => {});",
      "函数",
    ],
    [
      "返回对象里夹函数",
      "export const f = server(() => ({ onClick: () => {} }));",
      "函数",
    ],
    [
      "返回本文件局部定义的 helper",
      "export const f = server(() => { const helper = () => {}; return helper; });",
      "函数",
    ],
    [
      "返回 Stream",
      "export const f = server(async () => new ReadableStream());",
      "ReadableStream",
    ],
    [
      "分支里的 return",
      [
        "export const f = server(async (n) => {",
        "  if (n > 0) { return { ok: true }; }",
        "  return () => {};",
        "});",
      ].join("\n"),
      "函数",
    ],
  ];
  for (const [label, src, hint] of cases) {
    const err = catchCompile(src, "s.jsx");
    assert.equal(err.code, "PLAIN_E1007", label);
    assert.match(err.detail, /返回值/, label);
    assert.match(err.detail, new RegExp(hint), label);
  }
});

test("PLAIN_E1007 返回值不误报：可序列化数据 / 嵌套函数自己的 return / await", () => {
  const ok = [
    "export const f = server(() => 1);",
    "export const f = server(() => ({ a: 1, b: ['x'] }));",
    "export const f = server(() => { const rows = [1, 2]; return rows; });",
    "export const f = server(async () => { const d = await Promise.resolve(1); return { d }; });",
    "export const f = server(() => { if (1) return; return { ok: true }; });",
    // 嵌套函数自己的 return 不过 RPC 边界
    "export const f = server(() => { const make = () => () => {}; return make()(); });",
    "export const f = server(() => { return [1, 2].map((x) => x * 2); });",
    "export const f = server(() => new Date());",
  ];
  for (const src of ok) {
    assert.doesNotThrow(() => compile(src, "ok.jsx"), src);
  }
});

test("PLAIN_E1007 不误报：可序列化参数 / 看不出类型的标识符 / Date / spread", () => {
  const ok = [
    "export const f = server(async (n) => n);\nf(1);",
    "export const f = server(async (u) => u);\nf({ name: 'a', age: 1 });",
    "export const f = server(async (xs) => xs);\nf(['a', { n: 1 }]);",
    "export const f = server(async (d) => d);\nf(new Date());",
    "export const f = server(async (x) => x);\nconst data = { a: 1 };\nf(data);",
    "export const f = server(async (...xs) => xs);\nconst xs = [1];\nf(...xs);",
    "export const f = server(async () => 1);\nf();",
    "const a = server(async () => 1);\nconst b = server(async () => a());",
    'const checkKeyword = server(async (word) => word);\ncheckKeyword("x");',
  ];
  for (const src of ok) {
    assert.doesNotThrow(() => compile(src, "ok.jsx"), src);
  }
});

test("PLAIN_E1008：拒绝 JSX 属性展开 {...expr}（半套支持会静默跑错）", () => {
  const cases = [
    [
      "组件上展开",
      ["export function App(){", "  const rest = {};", "  return <Card {...rest} />;", "}"].join("\n"),
      3,
    ],
    [
      "原生元素上展开",
      ["export function App(){", "  return <input {...attrs} />;", "}"].join("\n"),
      2,
    ],
    [
      "嵌套子节点里也要拦",
      ["export function App(){", "  return <div><span {...x} /></div>;", "}"].join("\n"),
      2,
    ],
  ];
  for (const [label, src, line] of cases) {
    const err = catchCompile(src, "sp.jsx");
    assert.equal(err.code, "PLAIN_E1008", label);
    assert.equal(err.file, "sp.jsx", label);
    assert.equal(err.line, line, label);
    assert.match(err.detail, /静默跑错/, label);
    assert.match(err.hint, /显式属性/, label);
  }
});

test("PLAIN_E1008 不误报：普通属性 / 数组与对象展开 / 调用参数展开", () => {
  const ok = [
    "export function App(){ return <Card title={t} onClick={save} />; }",
    "export function App(){ const o = { a: 1 }; const b = { ...o, c: 2 }; return <b>{b.c}</b>; }",
    "export function App(){ const xs = [1]; return <div>{xs.map((x) => <span>{x}</span>)}</div>; }",
    "export const f = server(async (...xs) => xs);\nconst xs = [1];\nf(...xs);",
  ];
  for (const src of ok) {
    assert.doesNotThrow(() => compile(src, "ok.jsx"), src);
  }
});

test("合法输入不抛错，且默认返回 sourcemap", () => {
  const out = compile("export function App(){ return <p>x</p>; }", "ok.jsx");
  assert.equal(out.map.version, 3);
  assert.equal(compile("export function App(){ return <p>x</p>; }", "ok.jsx", {
    sourceMap: false,
  }).map, null);
});
