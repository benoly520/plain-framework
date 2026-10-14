// lint.ts 单测：契约规则 + 自动修复
//
// 覆盖点：signal-assign / signal-not-called（插值与属性两个分支）/ react-habit /
//        no-inner-html（三种写法）/ no-props-destructure / no-props-snapshot
//        （声明 / 赋值 / JSX 三种形态，含 on* 不误报）/ no-signal-mutate /
//        no-resolve-event-prop / resource 解构识别 / 不误伤 / formatIssues / 多修复
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

test("解构 props -> PLAIN_E1105（动态属性是 getter，会丢响应性）", () => {
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
  assert.match(issues[0].message, /resolve\(props\.x\)/);
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
  assert.match(chainIssues[0].message, /resolve\(props\.data\)/);
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

test("不误伤：非组件函数的参数解构 / resolve 之后再解构", () => {
  const cases = [
    [
      "export function util({ a }) { return a; }",
      "不返回 JSX，不是组件",
    ],
    [
      "export function App(){ return <ul>{rows.map(({ id }) => <li>{id}</li>)}</ul>; }",
      "map 回调的参数解构是合法写法",
    ],
    [
      "export function Card(props) { const { title } = resolve(props.data); return <h2>{title}</h2>; }",
      "先 resolve 再解构是正确写法",
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

test("把 getter 存进变量 / JSX 忘了 resolve -> PLAIN_E1112", () => {
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

  const resolveOnce = [
    "export function Card(props) {",
    "  const t = resolve(props.title);",
    "  return <h2>{t}</h2>;",
    "}",
  ].join("\n");
  assert.deepEqual(codes(check(resolveOnce, "Card.tsx")), ["PLAIN_E1112"]);

  const jsx = [
    "export function Card(props) {",
    "  return <h2>{props.title}</h2>;",
    "}",
  ].join("\n");
  const jsxIssues = check(jsx, "Card.tsx");
  assert.deepEqual(codes(jsxIssues), ["PLAIN_E1112"]);
  assert.match(jsxIssues[0].message, /resolve\(props\.title\)/);

  const attr = [
    "export function Card(props) {",
    "  return <input value={props.title} />;",
    "}",
  ].join("\n");
  assert.deepEqual(codes(check(attr, "Card.tsx")), ["PLAIN_E1112"]);
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
      'export function Card(props) { const cb = props["onClick"]; return <button onClick={cb}>x</button>; }',
      "下标形态的 on* prop 也算事件",
    ],
  ];
  for (const [src, why] of cases) {
    assert.deepEqual(check(src, "a.tsx"), [], why);
  }
});

test("resolve on* 事件 prop -> PLAIN_E1108（会把处理器当场调用）", () => {
  // 编译器对 on[A-Z] 的 prop 不包 getter，传进来的就是函数本身；
  // resolve(fn) = fn()，于是 resolve(props.onClick) 会当场调用处理器。
  const src = [
    "export function Card(props) {",
    "  const cb = resolve(props.onClick);",
    "  return <button onClick={cb}>x</button>;",
    "}",
  ].join("\n");
  const issues = check(src, "Card.tsx");
  assert.deepEqual(codes(issues), ["PLAIN_E1108"]);
  assert.match(issues[0].message, /当场调用/);
  assert.ok(issues[0].fix, "去掉 resolve 是唯一正确改法，可自动修");
  assert.ok(autofix(src, issues).includes("const cb = props.onClick;"));

  // 下标形态的 on* 同样拦
  assert.deepEqual(
    codes(check('export function Card(props) { return <b onClick={resolve(props["onClick"])}>x</b>; }', "a.tsx")),
    ["PLAIN_E1108"]
  );

  // 不误报：直接透传 / 直接调用 / 普通动态 props 的 resolve 都是对的
  const ok = [
    "export function Card(props) { return <button onClick={props.onClick}>x</button>; }",
    "export function Card(props) { return <button onClick={() => props.onClick(1)}>x</button>; }",
    "export function Card(props) { return <h2>{resolve(props.title)}</h2>; }",
  ];
  for (const s of ok) {
    assert.deepEqual(check(s, "a.tsx"), [], s);
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
