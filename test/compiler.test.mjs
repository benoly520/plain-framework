// compiler/index.ts 单测：产物形态 / server 物理剥离 / 报错兜底（行号）/ 属性与子节点各分支
import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../dist/compiler/index.js";

const jsx = (...lines) => lines.join("\n");

test("基础元素：生成建 DOM 代码、无 innerHTML、helper 走别名 import", () => {
  const { code } = compile(
    jsx("export function App() {", "  return <p>hello</p>;", "}"),
    "a.jsx"
  );
  assert.ok(code.startsWith("import { effect as __effect"));
  assert.ok(code.includes("createEl as __createEl"));
  assert.ok(code.includes('__createEl("p"'));
  assert.ok(code.includes("document.createTextNode"));
  assert.ok(!code.includes("innerHTML"));
});

test("块体 return：替换为「建 Fragment 并返回」", () => {
  const { code } = compile(
    jsx(
      "export function App() {",
      "  const x = 1;",
      "  return <p>{x}</p>;",
      "}"
    ),
    "blk.jsx"
  );
  assert.ok(code.includes("const __f") && code.includes("document.createDocumentFragment();"));
  assert.ok(code.includes("return __f"));
});

test("server() 物理剥离：客户端只剩 rpc 桩，函数体与闭包不外泄", () => {
  const { code, serverFunctions } = compile(
    jsx(
      "import { server } from 'plain';",
      "export const getVersion = server(async (n) => {",
      "  const secret = '不该出现';",
      "  return { n, secret };",
      "});"
    ),
    "s.jsx"
  );
  assert.equal(serverFunctions.length, 1);
  assert.equal(serverFunctions[0].name, "getVersion");
  assert.ok(code.includes('__rpc("getVersion"'));
  assert.ok(!code.includes("secret"));
  assert.ok(!code.includes("不该出现"));
});

test("条件表达式（三元）-> when，含 else 分支", () => {
  const { code } = compile(
    "export function App(){ return <div>{ok ? <b>y</b> : <i>n</i>}</div>; }",
    "c.jsx"
  );
  assert.ok(code.includes("__when("));
  assert.ok(code.includes("}, () => {"), "else 分支应为一段函数体");
});

test("与运算条件 -> when 且 else 传 null", () => {
  const { code } = compile(
    "export function App(){ return <div>{ok && <b>y</b>}</div>; }",
    "and.jsx"
  );
  assert.ok(code.includes("__when("));
  assert.ok(code.includes(", null);"));
});

test("arr.map 支持 index 参数，编译成 each", () => {
  const { code } = compile(
    "export function App(){ return <ul>{items.map((t, i) => <li>{i}{t}</li>)}</ul>; }",
    "l.jsx"
  );
  assert.ok(code.includes("__each("));
  assert.ok(code.includes("(t, i) =>"));
});

test("组件：props 收集 + children 包成 thunk + place 挂载", () => {
  const { code } = compile(
    jsx(
      "function Card(props){ return <section>{props.children()}</section>; }",
      "export function App(){ return <Card label=\"x\"><span>hi</span></Card>; }"
    ),
    "k.jsx"
  );
  assert.ok(code.includes("children: () => {"));
  assert.ok(code.includes('__place('));
  assert.match(code, /Card\(__props\d+\)/);
});

test("属性：动态 class 走 className、事件走 addEventListener、DOM 布尔属性直接赋值", () => {
  const { code } = compile(
    'export function App(){ return <input class={cls()} checked={ok()} onClick={fn} />; }',
    "e.jsx"
  );
  assert.ok(code.includes(".className = __stringify(cls())"));
  assert.ok(code.includes('addEventListener("click"'));
  assert.ok(code.includes(".checked = (ok())"));
});

test("属性：静态 class 字符串保持原生 setAttribute 语义", () => {
  const { code } = compile(
    'export function App(){ return <div class="a" />; }',
    "cls.jsx"
  );
  assert.ok(code.includes('setAttribute("class", "a")'));
});

test("属性：style 对象编译成 Object.assign（展开属性已由 PLAIN_E1008 拒绝）", () => {
  const { code } = compile(
    'export function App(){ return <div style={{color:"red"}} />; }',
    "st.jsx"
  );
  assert.ok(code.includes("Object.assign("));
});

test("内联函数 prop（返回 JSX）编译成真正的函数体", () => {
  const { code } = compile(
    'export function App(){ return <Card label="x" value={() => <b>1</b>} />; }',
    "fn.jsx"
  );
  // 函数体与普通渲染函数同口径：建 Fragment 再 return（细节见 control-flow.test.mjs）
  assert.match(code, /value: \(\) => \{\nconst __f\d+ = document\.createDocumentFragment\(\);/);
  assert.ok(code.includes('__createEl("b"'));
  assert.ok(!/<b>/.test(code), "产物不该残留 JSX");
});

test("普通表达式插值走 insert", () => {
  const { code } = compile("export function App(){ return <p>{1 + 2}</p>; }", "ins.jsx");
  assert.ok(code.includes("__insert("));
});

test("Fragment 子节点展开", () => {
  const { code } = compile("export function App(){ return <>{a}<b/></>; }", "f.jsx");
  assert.ok(code.includes('__createEl("b"'));
});

test("SVG 命名空间：svg 及其专属子标签统一走 createEl（不再用 document.createElement）", () => {
  const { code } = compile(
    'export function App(){ return <svg><polyline points="0 0 1 1"></polyline></svg>; }',
    "svg.jsx"
  );
  assert.ok(code.includes('__createEl("svg"'));
  assert.ok(code.includes('__createEl("polyline"'));
  assert.ok(!code.includes('document.createElement("polyline")'));
});

test("顶层裸 JSX（非 return）在编译期报错并带行号", () => {
  assert.throws(
    () =>
      compile(
        jsx("const x = <p>hi</p>;", "export function App(){ return <i/>; }"),
        "bad.jsx"
      ),
    /编译器还不认识[\s\S]*bad\.jsx:1/
  );
});

test("产物自检：产物无法被 JS 解析时直接报错，不交给打包器", () => {
  assert.throws(
    () =>
      compile(
        jsx("const z: = 1;", "export function App(){ return <p>{z}</p>; }"),
        "ts.jsx"
      ),
    /无法解析/
  );
});

// ---------------------------------------------------------------------------
// JSX 位置兜底：语法边界必须报「用户可见的 PLAIN_E1001」，而不是内部 bug E1003
// ---------------------------------------------------------------------------

test("JSX 位置：合法形状（三元 / && / map 回调 / 变量 / 属性箭头 / 工厂 return）正常编译", () => {
  const cases = {
    ternary: "export function C(){return <div>{a() ? <p>y</p> : <p>n</p>}</div>;}",
    and: "export function C(){return <div>{a() && <p>y</p>}</div>;}",
    mapCb: "export function C(){return <div>{xs().map(x => <li>{x}</li>)}</div>;}",
    varJsx: "export function C(){return <div>{v()}</div>;} function v(){return <span>s</span>;}",
    attrArrow:
      "export function C(){return <Box fallback={(e) => <p>err</p>} />;}",
    factoryReturn:
      "export function makeApp() { return () => <UserCtx.Provider value={'x'}><Who /></UserCtx.Provider>; }",
    namedFactoryReturn:
      "export function makeApp() { return function App() { return <p>hi</p>; }; }",
  };
  for (const [name, src] of Object.entries(cases)) {
    assert.doesNotThrow(() => compile(src, name + ".jsx"), name + " 应正常编译");
  }
});

test("JSX 位置：不支持的形状报 PLAIN_E1001（而不是 PLAIN_E1003 编译器 bug）", () => {
  const cases = {
    or: "export function C(){return <div>{a() || <p>x</p>}</div>;}",
    nullish: "export function C(){return <div>{a() ?? <p>x</p>}</div>;}",
    arrayLiteral: "export function C(){return <div>{[<p>a</p>,<p>b</p>]}</div>;}",
    iife: "export function C(){return <div>{(()=>{return <p>i</p>;})()}</div>;}",
    tryCatch:
      "export function C(){return <div>{(()=>{try{return <p>t</p>;}catch(e){return <p>c</p>;}})()}</div>;}",
    chainedFilterMap:
      "export function C(){return <div>{xs().map(x=><li>{x}</li>).filter(Boolean)}</div>;}",
  };
  for (const [name, src] of Object.entries(cases)) {
    assert.throws(
      () => compile(src, name + ".jsx"),
      (e) => e.code === "PLAIN_E1001" && /编译器还不认识/.test(e.detail),
      name + " 应报 PLAIN_E1001 并给出可行动的提示"
    );
  }
});

// ---------------------------------------------------------------------------
// 裸控制流 return：`return cond ? <a/> : <b/>` 这类「表达式本身就是控制流」的写法
//
// 曾经的 bug：规则 3 只认 `isJsxLike(expression)`，于是裸三元 / 裸 && / 裸 map
// 因为「expression 不是 JSX 字样」而漏编译，JSX 残留到产物里，最后被 assertClean
// 误报成 PLAIN_E1003「编译器 bug」。以下用例把修复后的边界钉死。
// ---------------------------------------------------------------------------

test("裸控制流 return：三元 / && / map / 提前 return 都应正常编译（不再误报 E1003）", () => {
  const cases = {
    ternary: "export function C(){ const a=true; return a ? <p>y</p> : <p>n</p>; }",
    and: "export function C(){ const a=true; return a && <p>y</p>; }",
    mapReturn: "export function C(){ const xs=[1]; return xs.map(x => <li>{x}</li>); }",
    nestedTernary:
      "export function C(){ const a=true,b=false; return a ? (b ? <p>1</p> : <p>2</p>) : <p>3</p>; }",
    varComponent:
      "export function C(){ const a=true; return a ? <A/> : <B/>; }",
    earlyReturn: "export function C(){ const y=1; if (y) return <p>x</p>; return <i/>; }",
    ifElseReturn:
      "export function C(){ const y=1; if (y) { return <p>x</p>; } else { return <i/>; } }",
    tryReturn:
      "export function C(){ try { return <p>t</p>; } catch(e) { return <i/>; } }",
    arrowTernary: "export const C = () => true ? <p>y</p> : <p>n</p>;",
    // map 回调体内也用裸三元（块体 / 简洁体）
    mapCbTernary:
      "export function C(){ const xs=[1]; return <ul>{xs.map(x => x ? <li>a</li> : <li>b</li>)}</ul>; }",
  };
  for (const [name, src] of Object.entries(cases)) {
    assert.doesNotThrow(() => compile(src, name + ".jsx"), name + " 应正常编译");
  }
});

test("裸控制流 return：产物里不应残留 JSX（真正编译成建 DOM 的代码）", () => {
  const { code } = compile(
    "export function C(){ const a=true; return a ? <p>y</p> : <i>n</i>; }",
    "bare.jsx"
  );
  assert.ok(!/<p>|<i>/.test(code), "产物里不应残留原始 JSX 标签：" + code);
  assert.ok(code.includes("__when("), "裸三元应编译成 when");
  assert.ok(code.includes("__createEl("), "应编译成建 DOM 的代码");
});

test("裸控制流 return：`||` / `??` 仍不支持，报 PLAIN_E1001 而不是 E1003", () => {
  const cases = {
    bareOr: "export function C(){ const a=true; return a || <p>y</p>; }",
    bareNullish: "export function C(){ const a=null; return a ?? <p>y</p>; }",
  };
  for (const [name, src] of Object.entries(cases)) {
    assert.throws(
      () => compile(src, name + ".jsx"),
      (e) => e.code === "PLAIN_E1001" && /编译器还不认识/.test(e.detail),
      name + " 应报 PLAIN_E1001"
    );
  }
});

test("组件工厂：`return () => <jsx/>` 由内层箭头自己编译，外层 return 不抢（曾误报 E1003）", () => {
  // 关键：外层 return 的表达式是「箭头函数值」，不是含 JSX 的表达式。
  // JSX 归内层箭头（规则 2）编译；若外层 return 抢着整体替换，就会漏编译内层 JSX。
  const cases = {
    arrowFactory:
      "export function makeApp(){ return () => <UserCtx.Provider value={'x'}><Who/></UserCtx.Provider>; }",
    fnFactory: "export function makeApp(){ return function App(){ return <p>hi</p>; }; }",
  };
  for (const [name, src] of Object.entries(cases)) {
    assert.doesNotThrow(() => compile(src, name + ".jsx"), name + " 应正常编译");
  }
});

// ---------------------------------------------------------------------------
// 渲染函数 / 列表回调体里的控制流
//
// 曾经的 bug：`emitStmt` 只递归 块 / if，`detectMap` 只认「回调体顶层的 return」，
// 于是「if / else 两个分支都是提前 return」的回调直接退化成 __insert（里面的 JSX 不编译），
// try / 循环 / switch / 就地小渲染函数里的 return 则被原样塞进产物 —— 两者都残留 JSX，
// 最后被 assertClean 误报成 PLAIN_E1003「编译器 bug」。
// 另一处静默失败：渲染函数 prop 只挑一个 JSX 体再 emitNode，`if (e) return <a/>; return <b/>;`
// 的提前 return 会被整个丢掉（产物只剩最后一个分支）。以下用例把修复后的边界钉死。
// ---------------------------------------------------------------------------

test("回调体内的控制流：if·else / try / 循环 / switch / 就地小渲染函数都应正常编译", () => {
  const cb = (body) => `export function C(){ return <ul>{xs().map((x) => ${body})}</ul>; }`;
  const cases = {
    ifElseOnly: cb("{ if (x.ok) return <li>y</li>; else return <li>n</li>; }"),
    tryCatch: cb("{ try { return <li>{x}</li>; } catch (e) { return <li>err</li>; } }"),
    tryFinally: cb("{ try { return <li/>; } finally { log(); } }"),
    forOf: cb("{ for (const y of x) { if (y) return <li>{y}</li>; } return <li/>; }"),
    whileLoop: cb("{ while (x.ok) { return <li/>; } return <li/>; }"),
    switchCase: cb('{ switch (x.k) { case 1: return <li>1</li>; default: return <li>d</li>; } }'),
    labeled: cb("{ outer: { return <li/>; } }"),
    fnDecl: cb("{ function row() { return <li>{x}</li>; } return <div>{row()}</div>; }"),
    fnExprVar: cb("{ const row = function () { return <li>{x}</li>; }; return <div>{row()}</div>; }"),
    arrowVar: cb("{ const row = () => <li>{x}</li>; return <div>{row()}</div>; }"),
    plainFnUntouched:
      cb("{ function double(n) { return n * 2; } return <li>{double(x)}</li>; }"),
    ifElseKey:
      "export function C(){ return <ul>{xs().map((x) => { if (x.ok) return <li key={x.id}>y</li>; else return <li key={x.id}>n</li>; })}</ul>; }",
  };
  for (const [name, src] of Object.entries(cases)) {
    assert.doesNotThrow(() => compile(src, name + ".jsx"), name + " 应正常编译");
  }
  // key 只认「回调返回的顶层元素」：回调体没有顶层 return 时也要能识别到 key
  const { code: keyed } = compile(cases.ifElseKey, "keyed.jsx");
  assert.ok(keyed.includes("(x) => ((x.id))"), "纯 if / else 回调的 key 应被识别：" + keyed);
});

test("回调体内的控制流：产物里不应残留 JSX，普通辅助函数的 return 不被改写", () => {
  const { code } = compile(
    `export function C(){ return <ul>{xs().map((x) => {
      if (x.ok) return <li>y</li>;
      else return <li>n</li>;
    })}</ul>; }`,
    "cb-residue.jsx"
  );
  assert.ok(!/<li>|<\/li>/.test(code), "产物里不应残留原始 JSX 标签：" + code);
  assert.ok(code.includes('__createEl("li"'), "应编译成建 DOM 的代码");

  const helper = compile(
    `export function C(){ return <ul>{xs().map((x) => {
      function double(n) { return n * 2; }
      return <li>{double(x)}</li>;
    })}</ul>; }`,
    "cb-helper.jsx"
  ).code;
  assert.ok(
    helper.includes("function double(n) { return n * 2; }"),
    "不含 JSX 的辅助函数应原样保留：" + helper
  );
});

test("回调体内分解不开的语句：报 PLAIN_E1001（而不是 PLAIN_E1003 编译器 bug）", () => {
  const cb = (body) => `export function C(){ return <ul>{xs().map((x) => ${body})}</ul>; }`;
  const cases = {
    exprStmtFn: cb("{ open(() => <p/>); return <li/>; }"),
    constJsxValue: cb("{ const el = <li/>; return <div>{el}</div>; }"),
    iife: cb("{ const v = (() => { return <li/>; })(); return <b>{v}</b>; }"),
    objPropFn: cb("{ const p = { children: () => <p/> }; return <li/>; }"),
    attrFn: "export function C(){ return <Box fallback={() => { open(() => <p/>); }} />; }",
  };
  for (const [name, src] of Object.entries(cases)) {
    assert.throws(
      () => compile(src, name + ".jsx"),
      (e) =>
        e.code === "PLAIN_E1001" &&
        /编译器还不认识/.test(e.detail) &&
        new RegExp(`${name}\\.jsx:1`).test(e.detail),
      name + " 应报 PLAIN_E1001 并带上出错行号"
    );
  }
});

test("渲染函数 prop：控制流里的 return 不再被静默丢掉（也不是 E1003）", () => {
  const cases = {
    ifElse:
      "export function C(){ return <Box render={(ok) => { if (ok) return <p>y</p>; return <p>n</p>; }} />; }",
    tryCatch:
      "export function C(){ return <Box render={() => { try { return <p>y</p>; } catch (e) { return <p>n</p>; } }} />; }",
    ternary: "export function C(){ return <Box render={(ok) => (ok ? <p>y</p> : <p>n</p>)} />; }",
    map: "export function C(){ return <Box render={() => <ul>{xs().map((x) => <li>{x}</li>)}</ul>} />; }",
    asyncRender: "export function C(){ return <Box render={async (ok) => <p>{ok}</p>} />; }",
  };
  for (const [name, src] of Object.entries(cases)) {
    const { code } = (() => {
      try {
        return compile(src, name + ".jsx");
      } catch (e) {
        assert.fail(name + " 应正常编译，实际：" + e.code);
      }
    })();
    assert.ok(!/<\/?[a-z][^>]*>/.test(code), name + " 产物里不应残留 JSX：" + code);
  }
  // 提前 return 必须真的进了产物（旧实现只留下最后一个分支）
  const { code } = compile(
    "export function C(){ return <Box render={(ok) => { if (ok) return <p>y</p>; return <p>n</p>; }} />; }",
    "prop-early.jsx"
  );
  assert.ok(code.includes("if (ok) {"), "提前 return 的条件分支应保留：" + code);
  // async 渲染函数不能被编译成同步函数
  assert.ok(
    /async \(ok\) =>/.test(compile(cases.asyncRender, "prop-async.jsx").code),
    "async 修饰符应保留"
  );
});
