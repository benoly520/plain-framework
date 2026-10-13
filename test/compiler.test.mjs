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
  assert.ok(code.includes('document.createElement("p")'));
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
  assert.ok(code.includes("const __f = document.createDocumentFragment();"));
  assert.ok(code.includes("return __f;"));
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

test("属性：style 对象、spread 展开", () => {
  const { code } = compile(
    'export function App(){ return <div style={{color:"red"}} {...rest} />; }',
    "st.jsx"
  );
  assert.ok(code.includes("Object.assign("));
  assert.ok(code.includes("removeAttribute(k)"));
  assert.ok(code.includes(".addEventListener(k.slice(2).toLowerCase()"));
});

test("内联函数 prop（返回 JSX）编译成真正的函数体", () => {
  const { code } = compile(
    'export function App(){ return <Card label="x" value={() => <b>1</b>} />; }',
    "fn.jsx"
  );
  assert.ok(code.includes("const __fb = document.createDocumentFragment();"));
});

test("普通表达式插值走 insert", () => {
  const { code } = compile("export function App(){ return <p>{1 + 2}</p>; }", "ins.jsx");
  assert.ok(code.includes("__insert("));
});

test("Fragment 子节点展开", () => {
  const { code } = compile("export function App(){ return <>{a}<b/></>; }", "f.jsx");
  assert.ok(code.includes('document.createElement("b")'));
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
