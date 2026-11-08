// lint.ts 单测：契约规则 + 自动修复
//
// 覆盖点：signal-assign / signal-not-called（插值与属性两个分支）/ react-habit /
//        no-inner-html（三种写法）/ no-props-destructure / no-props-snapshot
//        （声明 / 赋值两种形态，含 on* 不误报与回调内读取不误报）/ no-signal-mutate /
//        resource 解构识别 / 不误伤 / formatIssues / 多修复
import { test } from "node:test";
import assert from "node:assert/strict";
import { check, autofix, formatIssues, suppressionCount } from "../dist/lint.js";

const codes = (issues) => issues.map((i) => i.code);

test("直接给 signal 变量赋值 -> PLAIN_E1101，且 fix 可应用", () => {
  const src = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "count = count() + 1;",
  ].join("\n");
  const issues = check(src, "Counter.tsx");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "PLAIN_E1101");
  assert.equal(issues[0].level, "error");
  assert.equal(issues[0].line, 3);
  assert.equal(
    autofix(src, issues),
    src.replace("count = count() + 1;", "count.set(count() + 1);")
  );
});

test("JSX 插值里漏调用 signal -> PLAIN_E1102", () => {
  const src = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "export function App() { return <p>{count}</p>; }",
  ].join("\n");
  const issues = check(src, "App.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1102"]);
  assert.equal(issues[0].line, 3);
  assert.ok(autofix(src, issues).includes("<p>{count()}</p>"));
});

test("JSX 属性里漏调用 signal -> PLAIN_E1102", () => {
  const src = [
    "import { signal } from 'plain';",
    "const done = signal(false);",
    "export function App() { return <input checked={done} />; }",
  ].join("\n");
  const issues = check(src, "App.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1102"]);
  assert.ok(issues[0].message.includes("属性"));
  assert.ok(autofix(src, issues).includes("checked={done()}"));
});

test("React 肌肉记忆 API 只报错、不自动改", () => {
  for (const name of ["useState", "useEffect", "useMemo", "useCallback", "useRef"]) {
    const issues = check(`const x = ${name}(0);`, "a.tsx");
    assert.deepEqual(codes(issues), ["PLAIN_E1103"], name);
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
    assert.deepEqual(codes(check(src, "a.tsx")), ["PLAIN_E1104"], src);
  }
});

test("resource 解构出来的 data/loading/error 也按 signal 校验", () => {
  const src = [
    "import { resource } from 'plain';",
    "export function App() {",
    "  const { data, loading } = resource(() => 1);",
    "  loading = false;",
    "  return <p>{data()}</p>;",
    "}",
  ].join("\n");
  assert.deepEqual(codes(check(src, "a.tsx")), ["PLAIN_E1101"]);
});

test("模块作用域创建 resource -> PLAIN_E1113（import 时立即执行 / 无人回收）", () => {
  const src = [
    "import { resource } from 'plain';",
    "const user = resource(() => fetchUser());",
  ].join("\n");
  const issues = check(src, "a.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1113"]);
  assert.equal(issues[0].line, 2);
  assert.equal(issues[0].fix, undefined, "不自动修（要挪进组件 / createScope）");
});

test("resource 在组件 / createScope 内不报 PLAIN_E1113", () => {
  const cases = [
    "import { resource } from 'plain';\nexport function App(){ const r = resource(() => 1); return <p>{r.loading() ? '…' : r.data()}</p>; }",
    "import { resource, createScope } from 'plain';\nconst s = createScope(() => ({ r: resource(() => 1) }));",
  ];
  for (const src of cases) {
    assert.deepEqual(check(src, "a.tsx"), [], src);
  }
});

test("PLAIN_E1113 可用抑制指令压掉（确认误报时的出口）", () => {
  const src = [
    "import { resource } from 'plain';",
    "// plain-ignore-next-line PLAIN_E1113",
    "const user = resource(() => 1);",
  ].join("\n");
  assert.deepEqual(check(src, "a.tsx"), []);
});

test("useContext 的返回值是 getter：{x} 自动修成 {x()}，取属性报 PLAIN_E1114", () => {
  const src = [
    "import { createContext, useContext } from 'plain';",
    "const Ctx = createContext('light');",
    "export function A() { const t = useContext(Ctx); return <p>{t}</p>; }",
  ].join("\n");
  const issues = check(src, "a.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1102"]);
  assert.ok(autofix(src, issues).includes("<p>{t()}</p>"));

  const src2 = [
    "import { createContext, useContext } from 'plain';",
    "const Ctx = createContext({ name: 'x' });",
    "export function A() { const t = useContext(Ctx); return <p>{t.name}</p>; }",
  ].join("\n");
  const issues2 = check(src2, "a.tsx");
  assert.deepEqual(codes(issues2), ["PLAIN_E1114"]);
  assert.ok(issues2[0].message.includes("t().name"), issues2[0].message);
});

test("PLAIN_E1114：直接对 useContext(...) 取属性也报；先调用后再取属性不报", () => {
  const bad = [
    "import { createContext, useContext } from 'plain';",
    "const Ctx = createContext({ name: 'x' });",
    "export function A() { return <p>{useContext(Ctx).name}</p>; }",
  ].join("\n");
  assert.deepEqual(codes(check(bad, "a.tsx")), ["PLAIN_E1114"]);

  const good = [
    "import { createContext, useContext } from 'plain';",
    "const Ctx = createContext({ name: 'x' });",
    "export function A() { return <p>{useContext(Ctx)().name}</p>; }",
  ].join("\n");
  assert.deepEqual(check(good, "a.tsx"), []);
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

// ---------------------------------------------------------------------------
// PLAIN_E1115：React 拼写的属性名 —— 与规范写法**等价**，所以只提示 + 自动改写
// ---------------------------------------------------------------------------

test("PLAIN_E1115：className / htmlFor 只报 warn，并自动改写成 class / for", () => {
  const src = [
    "import { signal } from 'plain';",
    "const cls = signal('a');",
    'export function App() { return <div className={cls()} htmlFor="x">t</div>; }',
  ].join("\n");
  const issues = check(src, "App.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1115", "PLAIN_E1115"]);
  assert.ok(
    issues.every((i) => i.level === "warn"),
    "等价写法只提示、不报错（报 error 会因为拼写偏好把构建搞挂）"
  );

  const fixed = autofix(src, issues);
  assert.ok(fixed.includes("class={cls()}"), fixed);
  assert.ok(fixed.includes('for="x"'), fixed);
  assert.ok(!fixed.includes("className") && !fixed.includes("htmlFor"), fixed);
  // 改完即收敛：再 check 不应再有 PLAIN_E1115
  assert.deepEqual(check(fixed, "App.tsx"), []);
});

test("PLAIN_E1115 只在**内建元素**上生效，组件上的属性名是它自己的 prop", () => {
  const src =
    'export function App() { return <Card className="x" htmlFor={y}><Child className="z" /></Card>; }';
  assert.deepEqual(check(src, "a.tsx"), [], "组件 tag 上的 className / htmlFor 不报");
  // 点号形式（Ctx.Provider）同样算组件
  assert.deepEqual(
    check('export function App() { return <Ctx.Provider className="x" />; }', "a.tsx"),
    []
  );
});

test("PLAIN_E1115：规范写法与 SVG / 自定义元素上的其它属性不误伤", () => {
  const good = [
    'export function App() { return <label class="c" for="x">t</label>; }',
    'export function App() { return <svg viewBox="0 0 1 1"><circle class="c" /></svg>; }',
    'export function App() { return <div data-class="x" aria-label="y" />; }',
    // 命令式 DOM 的 el.className 是平台 API，与 JSX 属性无关，不能报
    'export function App() { return <canvas ref={(el) => { el.className = "c"; }} />; }',
  ].join("\n");
  assert.deepEqual(check(good, "a.tsx"), []);
});

test("PLAIN_E1115 可用抑制指令压掉（确认误报时的出口）", () => {
  const src = [
    "// plain-ignore-next-line PLAIN_E1115",
    'export function App() { return <div className="c" />; }',
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

test("解构 props -> PLAIN_E1105（解构拿到的是此刻的值，不会更新）", () => {
  const src = [
    "export function Card(props) {",
    "  const { title } = props;",
    "  return <p>{title}</p>;",
    "}",
  ].join("\n");
  const issues = check(src, "Card.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1105"]);
  assert.equal(issues[0].line, 2);
  assert.equal(issues[0].fix, undefined, "两种改法语义不同，不自动改");
  assert.match(issues[0].message, /props\.x/);
});

test("解构 props 的另外两种口径：参数解构 / props 链解构", () => {
  const param = "export function Card({ title }) { return <h2>{title}</h2>; }";
  const paramIssues = check(param, "Card.tsx");
  assert.deepEqual(codes(paramIssues), ["PLAIN_E1105"]);
  assert.match(paramIssues[0].message, /function Card\(props\)/);

  const arrow = "export const Row = ({ id }) => <li>{id}</li>;";
  assert.deepEqual(
    codes(check(arrow, "Row.tsx")),
    ["PLAIN_E1105"],
    "箭头组件同样要拦"
  );

  const chain = [
    "export function Card(props) {",
    "  const { title } = props.data;",
    "  return <h2>{title}</h2>;",
    "}",
  ].join("\n");
  const chainIssues = check(chain, "Card.tsx");
  assert.deepEqual(codes(chainIssues), ["PLAIN_E1105"]);
  assert.match(chainIssues[0].message, /props\.data/);
});

test("先存后改也拦：const arr = items(); arr.push(x)", () => {
  const cases = [
    ["const items = signal([]); const arr = items(); arr.push(1);", "别名方法调用"],
    ["const todo = signal({ done: false }); const row = todo(); row.done = true;", "别名属性写入"],
    ["const rows = signal([{ t: [] }]); const r = rows(); r[0].t.push('a');", "别名 + 深层路径"],
  ];
  for (const [src, why] of cases) {
    const issues = check(src, "a.tsx");
    assert.deepEqual(codes(issues), ["PLAIN_E1106"], why);
    assert.match(issues[0].message, /signal 是 /, why);
  }

  const scoped = [
    "const items = signal([]);",
    "function a() { const arr = items(); arr.push(1); }",
    "function b() { const arr = []; arr.push(1); }",
  ].join("\n");
  const scopedIssues = check(scoped, "a.tsx");
  assert.equal(scopedIssues.length, 1, "同名变量只在真正指向 signal 的作用域里报");
  assert.equal(scopedIssues[0].line, 2);

  // 拷贝 / 非 signal / 只读 —— 都不能误报
  const ok = [
    "const items = signal([]); const c = items().slice(); c.push(1);",
    "const items = signal([]); const c = [...items()]; c.push(1);",
    "const items = signal([]); const n = items().length; n + 1;",
    "const raw = []; const arr = raw; arr.push(1);",
  ];
  for (const src of ok) {
    assert.deepEqual(check(src, "a.tsx"), [], src);
  }
});

test("不误伤：非组件函数的参数解构 / map 回调解构", () => {
  const cases = [
    [
      "export function util({ a }) { return a; }",
      "不返回 JSX，不是组件",
    ],
    [
      "export function App(){ return <ul>{rows.map(({ id }) => <li>{id}</li>)}</ul>; }",
      "map 回调的参数解构是合法写法",
    ],
  ];
  for (const [src, why] of cases) {
    assert.deepEqual(check(src, "a.tsx"), [], why);
  }
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
  assert.match(text, /C\.tsx:3:1\s+\[PLAIN_E1101\]/);
});

test("文件名决定 ScriptKind：.ts 源码不报 JSX 类误判", () => {
  assert.deepEqual(check("const x: number = 1;", "a.ts"), []);
  assert.deepEqual(check("const obj = {};", "a.js"), []);
});

test("就地改 signal 值 -> PLAIN_E1106（push / 下标赋值）", () => {
  const push = [
    "import { signal } from 'plain';",
    "const items = signal(['a']);",
    "items().push('b');",
  ].join("\n");
  const issues = check(push, "a.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1106"]);
  assert.equal(issues[0].fix, undefined);
  assert.match(issues[0].message, /items\.set/);

  const indexSet = [
    "import { signal } from 'plain';",
    "const items = signal(['a']);",
    "items()[0] = 'z';",
  ].join("\n");
  assert.deepEqual(codes(check(indexSet, "a.tsx")), ["PLAIN_E1106"]);

  const propSet = [
    "import { signal } from 'plain';",
    "const box = signal({ n: 1 });",
    "box().n = 2;",
  ].join("\n");
  assert.deepEqual(codes(check(propSet, "a.tsx")), ["PLAIN_E1106"]);
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

test("深层路径就地改也拦：todos()[0].done = true / user().profile.name = 'x'", () => {
  const cases = [
    "const todos = signal([{ done: false }]); todos()[0].done = true;",
    "const user = signal({ profile: { name: '' } }); user().profile.name = 'x';",
    "const todos = signal([{ tags: [] }]); todos()[0].tags.push('a');",
    "const rows = signal([[]]); rows()[0][1] = 2;",
  ];
  for (const src of cases) {
    const issues = check(src, "a.tsx");
    assert.deepEqual(codes(issues), ["PLAIN_E1106"], src);
    assert.match(issues[0].message, /set\(/, src);
  }

  // 单层 / 属性写入仍是老行为
  assert.deepEqual(
    codes(check("const box = signal({}); box().n = 1;", "a.tsx")),
    ["PLAIN_E1106"]
  );

  // 不误伤：非就地链（filter / slice / map 返回新数组）改的是副本
  const ok = [
    "const items = signal([1]); items().filter((x) => x).push(1);",
    "const items = signal([1]); const c = items().slice(); c.push(1);",
    "const items = signal([1]); items().map((x) => x).length;",
  ];
  for (const src of ok) {
    assert.deepEqual(check(src, "a.tsx"), [], src);
  }
});

test("把 props 取值存进变量 -> PLAIN_E1112；JSX 里直接读是正确写法", () => {
  const store = [
    "export function Card(props) {",
    "  const t = props.title;",
    "  return <h2>{t}</h2>;",
    "}",
  ].join("\n");
  const storeIssues = check(store, "Card.tsx");
  assert.deepEqual(codes(storeIssues), ["PLAIN_E1112"]);
  assert.equal(storeIssues[0].line, 2);
  assert.equal(storeIssues[0].fix, undefined);
  assert.match(storeIssues[0].message, /props 是实时值/);

  const jsx = [
    "export function Card(props) {",
    "  return <h2>{props.title}</h2>;",
    "}",
  ].join("\n");
  assert.deepEqual(check(jsx, "Card.tsx"), [], "JSX 里直接读 props 是正确写法");

  const attr = [
    "export function Card(props) {",
    "  return <input value={props.title} />;",
    "}",
  ].join("\n");
  assert.deepEqual(check(attr, "Card.tsx"), [], "属性里直接读 props 也是正确写法");

  const inEffect = [
    "import { effect } from 'plain';",
    "export function Card(props) {",
    "  let t = '';",
    "  effect(() => { const v = props.title; t = String(v); });",
    "  return <h2>{t}</h2>;",
    "}",
  ].join("\n");
  assert.deepEqual(
    check(inEffect, "Card.tsx"),
    [],
    "effect 回调会随依赖重跑，在里面读 props 是正确用法"
  );
});

test("不误伤：thunk / JSX 直接读 / 事件透传 / 非组件", () => {
  const cases = [
    [
      "export function Card(props) { const t = () => props.title; return <h2>{t()}</h2>; }",
      "thunk 写法",
    ],
    [
      "export function Card(props) { return <h2>{props.title}</h2>; }",
      "JSX 里直接读 props",
    ],
    [
      "export function Card(props) { return <button onClick={props.onClick}>x</button>; }",
      "on* 事件 prop 是函数，透传合法",
    ],
    [
      "export function util(props) { const t = props.title; return t; }",
      "不返回 JSX，不是组件",
    ],
    [
      "export function Card(props) { const save = () => { const t = props.title; localStorage.setItem('t', t); }; return <button onClick={save}>x</button>; }",
      "事件回调里读取会随每次点击重新求值",
    ],
  ];
  for (const [src, why] of cases) {
    assert.deepEqual(check(src, "a.tsx"), [], why);
  }
});

test("[回归] 不误报：把 on* 事件 prop 存进变量（它本来就是函数）", () => {
  const cases = [
    [
      "export function Card(props) { const cb = props.onClick; return <button onClick={cb}>x</button>; }",
      "on* prop 存的就是函数，快照不丢响应性",
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

test("赋值形态的快照：let t; t = props.title -> PLAIN_E1112", () => {
  const src = [
    "export function Card(props) {",
    "  let t;",
    "  t = props.title;",
    "  return <h2>{t}</h2>;",
    "}",
  ].join("\n");
  const issues = check(src, "Card.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1112"]);
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
  assert.deepEqual(codes(check(signalAssign, "Card.tsx")), ["PLAIN_E1101"]);
});

test("effect(async …) -> PLAIN_E1109", () => {
  const src = [
    "import { effect, signal } from 'plain';",
    "const data = signal(null);",
    "effect(async () => {",
    "  const r = await fetch('/api');",
    "  data.set(await r.json());",
    "});",
  ].join("\n");
  const issues = check(src, "a.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1109"]);
  assert.match(issues[0].message, /await/);

  // 函数在别处定义 —— 看不出来，不猜
  assert.deepEqual(check("effect(load);", "a.tsx"), []);
});

test("effect 里把同一个 signal 读了又写 -> PLAIN_E1110", () => {
  const cases = [
    "const count = signal(0); effect(() => count.set(count() + 1));",
    "const items = signal([]); effect(() => { items.set([...items(), 1]); });",
    "const c = signal(0); effect(() => { const n = c(); c.set(n + 1); });",
  ];
  for (const src of cases) {
    const issues = check(src, "a.tsx");
    assert.deepEqual(codes(issues), ["PLAIN_E1110"], src);
    assert.match(issues[0].message, /死循环/);
  }
});

test("不误报：钳位写法 / 只写别的 signal / 回调里才写 / 函数式更新", () => {
  const cases = [
    [
      "const count = signal(0); effect(() => { if (count() > 10) count.set(0); });",
      "钳位会在第二轮收敛，不是死循环",
    ],
    [
      "const count = signal(0); effect(() => { if (count() > 10) count.set(count() - 1); });",
      "递减钳位同样收敛，不报",
    ],
    [
      "const count = signal(0); effect(() => { const n = count(); if (n > 10) count.set(n - 1); });",
      "本地中转 + 闸门：收敛，不报",
    ],
    [
      "const count = signal(0); effect(() => { count.set(0); });",
      "写常量不会自触发（Object.is 相同直接返回）",
    ],
    [
      "const count = signal(0); const total = signal(0); effect(() => { total.set(count()); });",
      "只写没读过的 signal",
    ],
    [
      "const count = signal(0); effect(() => { el.onclick = () => count.set(count() + 1); });",
      "事件回调里的写不会在 effect 执行时发生",
    ],
    [
      "const count = signal(0); effect(() => { count.set((p) => p + 1); });",
      "函数式更新没读 signal，不会订阅自己",
    ],
    ["effect(load);", "回调在别处定义，看不出来"],
  ];
  for (const [src, why] of cases) {
    assert.deepEqual(check(src, "a.tsx"), [], why);
  }
});

test("computed 里写 signal -> PLAIN_E1111", () => {
  const src = [
    "import { computed, signal } from 'plain';",
    "const count = signal(0);",
    "const doubled = computed(() => { count.set(1); return count() * 2; });",
  ].join("\n");
  const issues = check(src, "a.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1111"]);
  assert.match(issues[0].message, /纯函数/);

  const ok = [
    "const items = signal([1]); const n = computed(() => items().length);",
    "const c = signal(1); const d = computed(() => { const n = c(); return n * 2; });",
    "const d = computed(derive);",
  ];
  for (const src of ok) {
    assert.deepEqual(check(src, "a.tsx"), [], src);
  }
});

test("props 动态下标看不出来 -> 仍按 getter 报（不猜就不放行）", () => {
  const src = [
    "export function Card(props) {",
    "  const t = props[key];",
    "  return <h2>{t}</h2>;",
    "}",
  ].join("\n");
  assert.deepEqual(codes(check(src, "Card.tsx")), ["PLAIN_E1112"]);
});

test("plain-ignore-line / plain-ignore-next-line：确认误报时的出口", () => {
  const sameLine = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "count = count() + 1; // plain-ignore-line",
  ].join("\n");
  assert.deepEqual(check(sameLine, "a.tsx"), [], "不写规则码 => 抑制该行全部规则");
  assert.equal(autofix(sameLine, check(sameLine, "a.tsx")), sameLine, "不自动改抑制行");
  assert.equal(suppressionCount(sameLine), 1);

  const blockComment = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "count = count() + 1; /* plain-ignore-line */",
  ].join("\n");
  assert.deepEqual(check(blockComment, "a.tsx"), []);

  const nextLine = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "// plain-ignore-next-line plain/signal-assign",
    "count = count() + 1;",
  ].join("\n");
  assert.deepEqual(check(nextLine, "a.tsx"), []);

  // 规则码不匹配 => 照报（抑制必须点名，不然就是关掉整行）
  const mismatch = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "// plain-ignore-next-line plain/other-rule",
    "count = count() + 1;",
  ].join("\n");
  assert.deepEqual(codes(check(mismatch, "a.tsx")), ["PLAIN_E1101"]);

  // 只影响挂了指令的那一行
  const scoped = [
    "import { signal } from 'plain';",
    "const a = signal(0);",
    "const b = signal(0);",
    "// plain-ignore-next-line",
    "a = 1;",
    "b = 2;",
  ].join("\n");
  assert.deepEqual(codes(check(scoped, "a.tsx")), ["PLAIN_E1101"]);
  assert.equal(check(scoped, "a.tsx")[0].line, 6, "第 6 行那条照报");
});

test("[回归] 示例文本不算指令：字符串里的 / 文档注释中间的都不生效", () => {
  const docExample = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    "/**",
    " * 用法：// plain-ignore-next-line",
    " * count = count() + 1; // plain-ignore-line",
    " */",
    "count = count() + 1;",
  ].join("\n");
  assert.equal(suppressionCount(docExample), 0, "注释中间引用的写法不算指令");
  assert.deepEqual(codes(check(docExample, "a.tsx")), ["PLAIN_E1101"]);

  const inString = [
    "import { signal } from 'plain';",
    "const count = signal(0);",
    'const help = "count = 1; // plain-ignore-line";',
    "count = count() + 1;",
  ].join("\n");
  assert.equal(suppressionCount(inString), 0, "字符串里的不算指令");
  assert.deepEqual(codes(check(inString, "a.tsx")), ["PLAIN_E1101"]);
});

test("抑制按「报错行」匹配（多行节点要把指令放在报出来的那一行）", () => {
  const onReportLine = [
    "import { effect, signal } from 'plain';",
    "const count = signal(0);",
    "// plain-ignore-next-line plain/no-effect-loop",
    "effect(() => { count.set(count() + 1); });",
  ].join("\n");
  assert.deepEqual(check(onReportLine, "a.tsx"), []);

  const inside = [
    "import { effect, signal } from 'plain';",
    "const count = signal(0);",
    "effect(() => {",
    "  count.set(count() + 1); // plain-ignore-line plain/no-effect-loop",
    "});",
  ].join("\n");
  assert.deepEqual(
    codes(check(inside, "a.tsx")),
    ["PLAIN_E1110"],
    "挂在内部那一行不生效 —— 指令认的是 CLI 打出来的行号"
  );
});
// ---- 反模式 23：no-eager-computed-forward-ref（PLAIN_E1201）----
// 顶层 computed/effect 创建即求值，回调引用「后面才声明」的 const 会在
// import 阶段撞 TDZ。真实案例与提案见 docs/rfcs/computed-eager-tdz.md。

test("顶层 computed 引用后置 const -> PLAIN_E1201（真实案例形态）", () => {
  const src = [
    "import { signal, computed } from 'plain';",
    "const a = computed(() => b());",
    "const b = signal(0);",
  ].join("\n");
  const issues = check(src, "a.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1201"]);
  assert.equal(issues[0].line, 2);
  assert.equal(issues[0].fix, undefined, "重排声明顺序无法安全自动修");
  assert.ok(issues[0].message.includes('"b"'), "提示语要点出被前向引用的名字");
});

test("顶层 effect 引用后置 const 同样报 PLAIN_E1201", () => {
  const src = [
    "import { signal, effect } from 'plain';",
    "effect(() => console.log(later));",
    "const later = signal(0);",
  ].join("\n");
  assert.deepEqual(codes(check(src, "a.tsx")), ["PLAIN_E1201"]);
});

test("顶层 effect 引用后置的 class 声明 -> PLAIN_E1201", () => {
  const src = [
    "const make = effect(() => new Later());",
    "class Later {}",
  ].join("\n");
  assert.deepEqual(codes(check(src, "a.ts")), ["PLAIN_E1201"]);
});

test("组件函数体内的 computed 引用后置 const 不报（render 时才执行）", () => {
  const src = [
    "import { computed } from 'plain';",
    "export function App() { const a = computed(() => b()); return <p/>; }",
    "const b = 1;",
  ].join("\n");
  assert.deepEqual(check(src, "a.tsx"), []);
});

test("引用先声明的 const / 顶层函数声明（提升）不报", () => {
  const src = [
    "import { signal, computed } from 'plain';",
    "const b = signal(0);",
    "const a = computed(() => b());",
    "function helper() { return 1; }",
    "const c = computed(() => helper());",
  ].join("\n");
  assert.deepEqual(check(src, "a.tsx"), []);
});

test("var 声明无 TDZ，不报", () => {
  const src = [
    "const a = computed(() => v);",
    "var v = 1;",
  ].join("\n");
  assert.deepEqual(check(src, "a.ts"), []);
});

test("回调自有局部变量遮蔽同名模块声明，不报", () => {
  const src = [
    "const a = computed(() => { const b = 1; return b; });",
    "const b = 2;",
  ].join("\n");
  assert.deepEqual(check(src, "a.tsx"), []);
});

test("嵌套函数体内的引用不报（v1 欠报口径，测试钉死）", () => {
  const src = [
    "const a = computed(() => () => b);",
    "const b = 1;",
  ].join("\n");
  assert.deepEqual(check(src, "a.tsx"), []);
});

test("类型标注 / 属性名 / 对象键不是值引用，不报", () => {
  const src = [
    "const obj = { qux: 2 };",
    "const a = computed((): Foo => ({ bar: 1, baz: obj.qux }));",
    "type Foo = { bar: number; baz: number };",
  ].join("\n");
  // obj 在前（合法值引用）；返回类型标注里的 Foo 虽声明在后，但不是运行时引用
  assert.deepEqual(check(src, "a.tsx"), []);
});

test("解构声明的名字也算模块级声明：后置解构被引用时报 PLAIN_E1201", () => {
  const src = [
    "const a = computed(() => x + y);",
    "const { x, y } = parts;",
  ].join("\n");
  const issues = check(src, "a.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1201"]);
  assert.ok(issues[0].message.includes('"x"') && issues[0].message.includes('"y"'));
});

test("PLAIN_E1201 可被行级抑制指令抑制", () => {
  const src = [
    "const a = computed(() => b()); // plain-ignore-line PLAIN_E1201",
    "const b = 1;",
  ].join("\n");
  assert.deepEqual(check(src, "a.tsx"), []);
});
