// 编译产物 sourcemap：结构正确 + 生成块映射回它来自的那一行
// 这里用一个独立实现的 VLQ 解码器来校验，不复用被测代码的编码逻辑
import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../dist/compiler/index.js";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlq(str) {
  const out = [];
  let shift = 0;
  let value = 0;
  for (const ch of str) {
    const digit = B64.indexOf(ch);
    const hasContinuation = digit & 32;
    value += (digit & 31) << shift;
    if (hasContinuation) {
      shift += 5;
    } else {
      const negative = value & 1;
      let v = value >> 1;
      if (negative) v = -v;
      out.push(v);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

/** 解出「产物行号(0-based) -> { srcLine, srcCol }」，未映射的行不会出现在结果里 */
function decodeMappings(mappings) {
  const map = new Map();
  let srcLine = 0;
  let srcCol = 0;
  mappings.split(";").forEach((line, genLine) => {
    if (!line) return;
    const seg = decodeVlq(line);
    assert.equal(seg.length, 4, "每行应只发一个 [genCol, srcIdx, srcLine, srcCol]");
    srcLine += seg[2];
    srcCol += seg[3];
    map.set(genLine, { srcLine, srcCol });
  });
  return map;
}

const lineOfCode = (code, needle) => code.split("\n").findIndex((l) => l.includes(needle));

test("sourcemap 结构：version / sources / sourcesContent / 行数对齐", () => {
  const source = ["export function App() {", "  return <p>hi</p>;", "}"].join("\n");
  const { code, map } = compile(source, "a.jsx");

  assert.equal(map.version, 3);
  assert.equal(map.file, "a.jsx");
  assert.deepEqual(map.sources, ["a.jsx"]);
  assert.deepEqual(map.sourcesContent, [source]);
  assert.deepEqual(map.names, []);
  assert.equal(
    map.mappings.split(";").length,
    code.split("\n").length,
    "mappings 的分组数应与产物行数一致"
  );
});

test("sourcemap：helper import 行没有源码对应，生成块映射回原语句那一行", () => {
  const source = ["export function App() {", "  return <p>hi</p>;", "}"].join("\n");
  const { code, map } = compile(source, "a.jsx");
  const decoded = decodeMappings(map.mappings);

  assert.equal(decoded.has(0), false, "第 0 行是注入的 helper import，不应有映射");

  const genLine = lineOfCode(code, 'document.createElement("p")');
  assert.ok(genLine > 0);
  assert.equal(
    decoded.get(genLine).srcLine,
    1,
    "生成块应映射回 return 语句所在的源码行（0-based 1）"
  );
});

test("sourcemap：未被改动的行保持 1:1 映射", () => {
  const source = [
    "const x = 1;",
    "const y = 2;",
    "export function App() {",
    "  return <p>{x + y}</p>;",
    "}",
  ].join("\n");
  const { code, map } = compile(source, "b.jsx");
  const decoded = decodeMappings(map.mappings);

  assert.equal(decoded.get(lineOfCode(code, "const y = 2;")).srcLine, 1);
  assert.equal(decoded.get(lineOfCode(code, "const x = 1;")).srcLine, 0);
});

test("sourcemap：多组件文件里，插值行映射回各自组件的插值语句", () => {
  const source = [
    "import { signal } from 'plain';",
    "const n = signal(0);",
    "export function A() {",
    "  return <p>{n()}</p>;",
    "}",
    "export function B() {",
    "  return <span>tail</span>;",
    "}",
  ].join("\n");
  const { code, map } = compile(source, "c.jsx");
  const decoded = decodeMappings(map.mappings);

  const insertLine = lineOfCode(code, "__insert(");
  assert.ok(insertLine > 0);
  assert.equal(
    decoded.get(insertLine).srcLine,
    3,
    "A 里的插值应映射回第 4 行（0-based 3）"
  );
});

test("sourcemap：mapSource 可覆盖 sources 路径（vite 插件用它写真实模块路径）", () => {
  const { map } = compile("export function App(){ return <p/>; }", "App.jsx", {
    mapSource: "/abs/src/App.tsx",
  });
  assert.deepEqual(map.sources, ["/abs/src/App.tsx"]);
});
