// lint.ts 单测：契约规则 + 自动修复
//
// 覆盖点：signal-assign / signal-not-called（插值与属性两个分支）/ react-habit /
//        no-inner-html（三种写法）/ resource 解构识别 / 不误伤 / formatIssues / 多修复
import { test } from "node:test";
import assert from "node:assert/strict";
import { check, autofix, formatIssues } from "../dist/lint.js";

const codes = (issues) => issues.map((i) => i.code);

test("直接给 signal 变量赋值 -> plain/signal-assign，且 fix 可应用", () => {
  const src = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "count = count() + 1;",
  ].join("\n");
  const issues = check(src, "Counter.tsx");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "plain/signal-assign");
  assert.equal(issues[0].level, "error");
  assert.equal(issues[0].line, 3);
  assert.equal(
    autofix(src, issues),
    src.replace("count = count() + 1;", "count.set(count() + 1);")
  );
});

test("JSX 插值里漏调用 signal -> plain/signal-not-called", () => {
  const src = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "export function App() { return <p>{count}</p>; }",
  ].join("\n");
  const issues = check(src, "App.tsx");
  assert.deepEqual(codes(issues), ["plain/signal-not-called"]);
  assert.equal(issues[0].line, 3);
  assert.ok(autofix(src, issues).includes("<p>{count()}</p>"));
});

test("JSX 属性里漏调用 signal -> plain/signal-not-called", () => {
  const src = [
    "import { signal } from 'plain';",
    "const done = signal(false);",
    "export function App() { return <input checked={done} />; }",
  ].join("\n");
  const issues = check(src, "App.tsx");
  assert.deepEqual(codes(issues), ["plain/signal-not-called"]);
  assert.ok(issues[0].message.includes("属性"));
  assert.ok(autofix(src, issues).includes("checked={done()}"));
});

test("React 肌肉记忆 API 只报错、不自动改", () => {
  for (const name of ["useState", "useEffect", "useMemo", "useCallback", "useRef"]) {
    const issues = check(`const x = ${name}(0);`, "a.tsx");
    assert.deepEqual(codes(issues), ["plain/react-habit"], name);
    assert.equal(issues[0].fix, undefined, `${name} 不应有自动修复`);
  }
});

test("innerHTML / outerHTML / insertAdjacentHTML 都被拦下", () => {
  const cases = [
    "el.innerHTML = '<b>x</b>';",
    "el.outerHTML = '<b>x</b>';",
    "el.insertAdjacentHTML('beforeend', '<b>x</b>');",
  ];
  for (const src of cases) {
    assert.deepEqual(codes(check(src, "a.tsx")), ["plain/no-inner-html"], src);
  }
});

test("resource 解构出来的 data/loading/error 也按 signal 校验", () => {
  const src = [
    "import { resource } from 'plain';",
    "const { data, loading } = resource(() => 1);",
    "loading = false;",
  ].join("\n");
  assert.deepEqual(codes(check(src, "a.tsx")), ["plain/signal-assign"]);
});

test("不误伤：声明 / 对象属性赋值 / 普通变量赋值", () => {
  const src = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "let plainVar = 0;",
    "plainVar = 1;",
    "const box = { count: 1 };",
    "box.count = 2;",
  ].join("\n");
  assert.deepEqual(check(src, "a.tsx"), []);
});

test("[回归] 属性场景只报一次，且 autofix 不会重复插入调用", () => {
  const src = [
    "import { signal } from 'plain';",
    "const done = signal(false);",
    "export function App() { return <input checked={done} />; }",
  ].join("\n");
  const issues = check(src, "a.tsx");
  assert.equal(issues.length, 1, "同一标识符只应报一次");
  const fixed = autofix(src, issues);
  assert.ok(fixed.includes("checked={done()}"));
  assert.ok(!fixed.includes("done()()"), "区间重叠曾把源码切成 done()()");
});

test("同一文件多个问题：按行排序且一次性全部修复", () => {
  const src = [
    "import { signal } from 'plain';",
    "const a = signal(0);",
    "const b = signal(0);",
    "a = 1;",
    "export function App() { return <p>{b}</p>; }",
  ].join("\n");
  const issues = check(src, "a.tsx");
  assert.equal(issues.length, 2);
  assert.ok(issues[0].line <= issues[1].line, "应按行号升序");
  const fixed = autofix(src, issues);
  assert.ok(fixed.includes("a.set(1);"));
  assert.ok(fixed.includes("{b()}"));
});

test("autofix 对无可修复项返回原样", () => {
  const src = "el.innerHTML = 'x';";
  assert.equal(autofix(src, check(src, "a.tsx")), src);
});

test("formatIssues 输出 文件:行:列 + 规则码", () => {
  const src = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "count = 1;",
  ].join("\n");
  const text = formatIssues(check(src, "C.tsx"), "C.tsx");
  assert.match(text, /C\.tsx:3:1\s+\[plain\/signal-assign\]/);
});

test("文件名决定 ScriptKind：.ts 源码不报 JSX 类误判", () => {
  assert.deepEqual(check("const x: number = 1;", "a.ts"), []);
  assert.deepEqual(check("const obj = {};", "a.js"), []);
});
