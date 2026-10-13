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

test("合法输入不抛错，且默认返回 sourcemap", () => {
  const out = compile("export function App(){ return <p>x</p>; }", "ok.jsx");
  assert.equal(out.map.version, 3);
  assert.equal(compile("export function App(){ return <p>x</p>; }", "ok.jsx", {
    sourceMap: false,
  }).map, null);
});
