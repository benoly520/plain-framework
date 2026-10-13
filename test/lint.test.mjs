// lint.ts 单测：契约规则 + 自动修复
//
// 覆盖点：signal-assign / signal-not-called（插值与属性两个分支）/ react-habit /
//        no-inner-html（三种写法）/ no-props-destructure / no-props-snapshot
//        （声明 / 赋值 / JSX 三种形态，含 on* 不误报）/ no-signal-mutate /
//        resource 解构识别 / 不误伤 / formatIssues / 多修复
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

test("解构 props -> plain/no-props-destructure（动态属性是 getter，会丢响应性）", () => {
  const src = [
    "export function Card(props) {",
    "  const { title } = props;",
    "  return <p>{title}</p>;",
    "}",
  ].join("\n");
  const issues = check(src, "Card.tsx");
  assert.deepEqual(codes(issues), ["plain/no-props-destructure"]);
  assert.equal(issues[0].line, 2);
  assert.equal(issues[0].fix, undefined, "两种改法语义不同，不自动改");
  assert.match(issues[0].message, /resolve\(props\.x\)/);
});

test("不误伤：非组件函数 / map 回调里解构行数据 / resource 解构", () => {
  const cases = [
    ["export function util(config) { const { a } = config; return a; }", "不返回 JSX，不是组件"],
    [
      "export function App(){ return <ul>{rows.map(r => { const { id } = r; return <li>{id}</li>; })}</ul>; }",
      "map 回调里解构行数据是合法写法",
    ],
    [
      "export function App(){ const { data } = resource(() => 1); return <p>{data()}</p>; }",
      "resource 解构是官方用法",
    ],
  ];
  for (const [src, why] of cases) {
    assert.deepEqual(check(src, "a.tsx"), [], why);
  }
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

test("就地改 signal 值 -> plain/no-signal-mutate（push / 下标赋值）", () => {
  const push = [
    "import { signal } from 'plain';",
    "const items = signal(['a']);",
    "items().push('b');",
  ].join("\n");
  const issues = check(push, "a.tsx");
  assert.deepEqual(codes(issues), ["plain/no-signal-mutate"]);
  assert.equal(issues[0].fix, undefined);
  assert.match(issues[0].message, /items\.set/);

  const indexSet = [
    "import { signal } from 'plain';",
    "const items = signal(['a']);",
    "items()[0] = 'z';",
  ].join("\n");
  assert.deepEqual(codes(check(indexSet, "a.tsx")), ["plain/no-signal-mutate"]);

  const propSet = [
    "import { signal } from 'plain';",
    "const box = signal({ n: 1 });",
    "box().n = 2;",
  ].join("\n");
  assert.deepEqual(codes(check(propSet, "a.tsx")), ["plain/no-signal-mutate"]);
});

test("不误伤：不可变更新 / 非 signal 数组的 push / .set", () => {
  const src = [
    "import { signal } from 'plain';",
    "const items = signal(['a']);",
    "items.set([...items(), 'b']);",
    "items.set(items().concat(['c']));",
    "items.set(items().filter((x) => x !== 'a'));",
    "const raw = [];",
    "raw.push(1);",
  ].join("\n");
  assert.deepEqual(check(src, "a.tsx"), []);
});

test("把 getter 存进变量 / JSX 忘了 resolve -> plain/no-props-snapshot", () => {
  const store = [
    "export function Card(props) {",
    "  const t = props.title;",
    "  return <h2>{t}</h2>;",
    "}",
  ].join("\n");
  const storeIssues = check(store, "Card.tsx");
  assert.deepEqual(codes(storeIssues), ["plain/no-props-snapshot"]);
  assert.equal(storeIssues[0].line, 2);
  assert.equal(storeIssues[0].fix, undefined);

  const resolveOnce = [
    "export function Card(props) {",
    "  const t = resolve(props.title);",
    "  return <h2>{t}</h2>;",
    "}",
  ].join("\n");
  assert.deepEqual(codes(check(resolveOnce, "Card.tsx")), ["plain/no-props-snapshot"]);

  const jsx = [
    "export function Card(props) {",
    "  return <h2>{props.title}</h2>;",
    "}",
  ].join("\n");
  const jsxIssues = check(jsx, "Card.tsx");
  assert.deepEqual(codes(jsxIssues), ["plain/no-props-snapshot"]);
  assert.match(jsxIssues[0].message, /resolve\(props\.title\)/);

  const attr = [
    "export function Card(props) {",
    "  return <input value={props.title} />;",
    "}",
  ].join("\n");
  assert.deepEqual(codes(check(attr, "Card.tsx")), ["plain/no-props-snapshot"]);
});

test("不误伤：thunk / 内联 resolve / 事件透传 / 非组件", () => {
  const cases = [
    [
      "export function Card(props) { const t = () => resolve(props.title); return <h2>{t()}</h2>; }",
      "官方 thunk 写法",
    ],
    [
      "export function Card(props) { return <h2>{resolve(props.title)}</h2>; }",
      "JSX 里内联 resolve",
    ],
    [
      "export function Card(props) { return <button onClick={props.onClick}>x</button>; }",
      "on* 事件 prop 不是 getter，透传合法",
    ],
    [
      "export function util(props) { const t = props.title; return t; }",
      "不返回 JSX，不是组件",
    ],
  ];
  for (const [src, why] of cases) {
    assert.deepEqual(check(src, "a.tsx"), [], why);
  }
});

test("[回归] 不误报：把 on* 事件 prop 存进变量（编译器不给 on* 包 getter）", () => {
  const cases = [
    [
      "export function Card(props) { const cb = props.onClick; return <button onClick={cb}>x</button>; }",
      "on* prop 存的本来就是函数，快照不丢响应性",
    ],
    [
      "export function Card(props) { const cb = resolve(props.onClick); return <button onClick={cb}>x</button>; }",
      "resolve 包一层的 on* prop 同样不报",
    ],
    [
      'export function Card(props) { const cb = props["onClick"]; return <button onClick={cb}>x</button>; }',
      "下标形态的 on* prop 也算事件",
    ],
  ];
  for (const [src, why] of cases) {
    assert.deepEqual(check(src, "a.tsx"), [], why);
  }
});

test("赋值形态的快照：let t; t = props.title -> plain/no-props-snapshot", () => {
  const src = [
    "export function Card(props) {",
    "  let t;",
    "  t = props.title;",
    "  return <h2>{t}</h2>;",
    "}",
  ].join("\n");
  const issues = check(src, "Card.tsx");
  assert.deepEqual(codes(issues), ["plain/no-props-snapshot"]);
  assert.equal(issues[0].line, 3);
  assert.match(issues[0].message, /t = props\.title/);
  assert.equal(issues[0].fix, undefined, "两种改法语义不同，不自动改");
});

test("不误报：赋值写在 effect / 回调里会重跑；on* 赋值；signal 赋值归 signal-assign", () => {
  const cases = [
    [
      "import { effect } from 'plain'; export function Card(props) { let t; effect(() => { t = props.title; }); return <h2>{t}</h2>; }",
      "effect 会随依赖重跑，赋值是正确用法",
    ],
    [
      "export function Card(props) { let t; const save = () => { t = props.title; }; return <button onClick={save}>x</button>; }",
      "事件回调里赋值同样会重跑",
    ],
    [
      "export function Card(props) { let cb; cb = props.onClick; return <button onClick={cb}>x</button>; }",
      "on* 事件 prop 赋值不按快照报",
    ],
  ];
  for (const [src, why] of cases) {
    assert.deepEqual(check(src, "a.tsx"), [], why);
  }

  const signalAssign = [
    "import { signal } from 'plain';",
    "export function Card(props) {",
    "  const s = signal(0);",
    "  s = props.count;",
    "  return <h2>{s()}</h2>;",
    "}",
  ].join("\n");
  assert.deepEqual(codes(check(signalAssign, "Card.tsx")), ["plain/signal-assign"]);
});

test("props 动态下标看不出来 -> 仍按 getter 报（不猜就不放行）", () => {
  const src = [
    "export function Card(props) {",
    "  const t = props[key];",
    "  return <h2>{t}</h2>;",
    "}",
  ].join("\n");
  assert.deepEqual(codes(check(src, "Card.tsx")), ["plain/no-props-snapshot"]);
});
