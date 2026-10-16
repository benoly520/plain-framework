// 属性归一化回归测试
//
// 钉住的不变量：**同一个属性，无论写成静态字面量还是动态表达式、无论用兼容拼写
// 还是规范拼写，都必须归一到同一个属性身份**（src/attrs.ts 一张表）。
//
// 修复的两个历史 bug：
//   1. `<label htmlFor="x">` 静态产物落到属性名 "htmlFor"（浏览器会小写成 htmlfor，
//      不是 <label> 认的 for），而动态产物落到 .htmlFor —— 两条路静默分叉；
//   2. 动态属性走 property，而 SSR 垫片不把 property 反射回 attributes，
//      于是 SSR 下动态 href / value / checked 整条丢失。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { compile } from "../dist/compiler/index.js";
import {
  canonicalAttrName,
  resolveAttr,
  REFLECTED_ATTRS,
  REACT_COMPAT_ALIASES,
  HTML_HYPHEN_ALIASES,
} from "../dist/attrs.js";
import { createDocument, serializeNode } from "../dist/server/dom-shim.js";
import { renderToStringSync } from "../dist/server/render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_URL = pathToFileURL(path.join(ROOT, "dist/runtime/index.js")).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-attrs-"));

/** 取出编译产物里跟属性相关的行（就是「落到哪个属性」的唯一证据） */
function attrLines(code) {
  return code
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /setAttribute\(|removeAttribute\(|addEventListener\(|__el\d+\.\w+ =/.test(l));
}

/** 编译一个模块（去 TS 类型 -> plain 编译 -> import 指向 dist 运行时） */
let seq = 0;
async function loadModule(tsx, name) {
  const stripped = await esbuild.transform(tsx, {
    loader: "tsx",
    jsx: "preserve",
    target: "es2022",
    format: "esm",
  });
  const out = compile(stripped.code, `${name}.jsx`);
  const code = out.code.replace(/from\s+["']plain["']/g, `from "${RUNTIME_URL}"`);
  const file = path.join(TMP, `${name}-${seq++}.mjs`);
  fs.writeFileSync(file, code);
  const mod = await import(pathToFileURL(file).href + `?v=${Date.now()}`);
  return { mod, code };
}

// ---------------------------------------------------------------------------
// 1. 规范化表本身
// ---------------------------------------------------------------------------

test("canonicalAttrName：兼容拼写全部归一，SVG / MathML 保留大小写", () => {
  assert.equal(canonicalAttrName("className"), "class");
  assert.equal(canonicalAttrName("htmlFor"), "for");
  assert.equal(canonicalAttrName("maxLength"), "maxlength");
  assert.equal(canonicalAttrName("tabIndex"), "tabindex");
  assert.equal(canonicalAttrName("readOnly"), "readonly");
  assert.equal(canonicalAttrName("colSpan"), "colspan");
  assert.equal(canonicalAttrName("acceptCharset"), "accept-charset");
  // SVG：大小写敏感，必须是原样（小写就直接失效）
  assert.equal(canonicalAttrName("viewBox", "svg"), "viewBox");
  assert.equal(canonicalAttrName("preserveAspectRatio", "svg"), "preserveAspectRatio");
  assert.equal(canonicalAttrName("linearGradient", "linearGradient"), "linearGradient");
  // SVG 上写 className 仍要落到 class（SVG 的 className 是只读的 SVGAnimatedString）
  assert.equal(canonicalAttrName("className", "circle"), "class");
  // 自定义属性原样
  assert.equal(canonicalAttrName("data-foo"), "data-foo");
  assert.equal(canonicalAttrName("aria-label"), "aria-label");
});

test("React 兼容面被显式钉住：只有 className / htmlFor 两个", () => {
  // 这里是一道「显式决定」的闸：扩大 React 兼容面必须先改这份清单，
  // 而不是在编译器里顺手加一个特判分支（`htmlFor` 的静默失效就是这么来的）。
  assert.deepEqual(REACT_COMPAT_ALIASES, { className: "class", htmlFor: "for" });
});

test("兼容表的值必须是规范名（幂等：不许出现别名链或拼错的目标）", () => {
  for (const [from, to] of Object.entries({
    ...REACT_COMPAT_ALIASES,
    ...HTML_HYPHEN_ALIASES,
  })) {
    assert.notEqual(from, to, `${from} 的别名目标不能是它自己`);
    assert.equal(
      canonicalAttrName(to),
      to,
      `${from} -> ${to} 的目标不是规范名（会被二次改写）`
    );
  }
});

test("REFLECTED_ATTRS 与 resolveAttr 保持一致（property 项不许漏表）", () => {
  for (const [attr, reflected] of Object.entries(REFLECTED_ATTRS)) {
    const op = resolveAttr(attr);
    assert.equal(op.kind, "prop", `${attr} 应走 property`);
    assert.equal(op.prop, reflected.prop, `${attr} -> ${reflected.prop}`);
  }
  // SVG 上一律走属性（不能赋 property）
  assert.deepEqual(resolveAttr("className", "svg"), { kind: "attr", name: "class" });
  assert.deepEqual(resolveAttr("value", "circle"), { kind: "attr", name: "value" });
});

// ---------------------------------------------------------------------------
// 2. 静态 / 动态 / 兼容拼写三者必须等价（本次修复的核心）
// ---------------------------------------------------------------------------

/** 每个属性的所有可接受拼写：任一拼写的产物都必须和第一个完全一致 */
const SPELLING_GROUPS = [
  ["class", "className"],
  ["for", "htmlFor"],
  ["maxlength", "maxLength"],
  ["minlength", "minLength"],
  ["tabindex", "tabIndex"],
  ["readonly", "readOnly"],
  ["colspan", "colSpan"],
  ["acceptcharset", "acceptCharset"],
  ["title"],
  ["value"],
  ["checked"],
];

test("同一属性的所有拼写：静态产物完全一致（且落到规范属性名）", () => {
  for (const group of SPELLING_GROUPS) {
    const canonical = canonicalAttrName(group[0]);
    const groups = group.map((s) =>
      attrLines(compile(`export function A(){ return <div ${s}="v" />; }`, "s.jsx").code)
    );
    for (const lines of groups) {
      assert.deepEqual(lines, groups[0], `${group.join(" / ")} 的静态产物必须一致`);
    }
    assert.equal(
      groups[0].length,
      1,
      `${group.join(" / ")} 静态应只产生一条属性语句`
    );
    assert.ok(
      groups[0][0].includes(`setAttribute(${JSON.stringify(canonical)}, "v")`),
      `${group.join(" / ")} 应落到规范名 ${canonical}，实际：${groups[0][0]}`
    );
  }
});

test("同一属性的所有拼写：动态产物完全一致", () => {
  for (const group of SPELLING_GROUPS) {
    const groups = group.map((s) =>
      attrLines(compile(`export function A(){ return <div ${s}={x} />; }`, "d.jsx").code)
    );
    for (const lines of groups) {
      assert.deepEqual(lines, groups[0], `${group.join(" / ")} 的动态产物必须一致`);
    }
  }
});

test("回归：<label htmlFor=\"x\"> 不得再产出属性名 htmlFor", () => {
  const { code } = compile(
    'export function A(){ return <label htmlFor="x">a</label>; }',
    "hf.jsx"
  );
  assert.ok(code.includes('setAttribute("for", "x")'), code);
  assert.ok(!code.includes('"htmlFor"'), "属性名必须归一化为 for：" + code);
});

test("静态属性名一律小写（HTML 命名空间内不允许再出现 camelCase 属性名）", () => {
  const spellings = SPELLING_GROUPS.flat();
  for (const s of spellings) {
    const { code } = compile(`export function A(){ return <div ${s}="v" />; }`, "lc.jsx");
    assert.ok(
      !/setAttribute\("[A-Z]/.test(code),
      `${s} 产出了大写开头的属性名：${code}`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. SVG / MathML：属性名大小写敏感，class 不能赋只读的 className
// ---------------------------------------------------------------------------

test("SVG：viewBox 保留大小写，class 走 setAttribute（不赋只读的 className）", () => {
  const { code } = compile(
    'export function A(){ return <svg viewBox="0 0 1 1"><circle className={c()} /></svg>; }',
    "svg.jsx"
  );
  assert.ok(code.includes('setAttribute("viewBox", "0 0 1 1")'), code);
  assert.ok(code.includes('setAttribute("class"'), code);
  assert.ok(!code.includes(".className ="), "SVG 的 className 是只读的，不能赋值：" + code);
});

test("MathML：与 SVG 同一条命名空间规则（属性名保留大小写）", () => {
  assert.equal(canonicalAttrName("mathvariant", "mi"), "mathvariant");
  assert.deepEqual(resolveAttr("value", "mo"), { kind: "attr", name: "value" });

  const doc = createDocument();
  const mi = doc.createElementNS("http://www.w3.org/1998/Math/MathML", "mi");
  mi.setAttribute("mathvariant", "bold");
  assert.equal(mi.getAttribute("mathvariant"), "bold");
  assert.equal(serializeNode(mi), '<mi mathvariant="bold"></mi>');
});

// ---------------------------------------------------------------------------
// 4. SSR 垫片：属性名规则与浏览器一致；property 必须反射回 attributes
// ---------------------------------------------------------------------------

test("SSR 垫片：HTML 属性名小写、SVG 保留大小写", () => {
  const doc = createDocument();
  // 与浏览器一致：HTML 元素的属性名一律小写（编译器产出的本来就是规范名）
  const cell = doc.createElement("td");
  cell.setAttribute("colSpan", "2");
  assert.equal(cell.getAttribute("colspan"), "2");
  // 与浏览器一致：读也走同一套小写规则（getAttribute("colSpan") 同样命中）
  assert.equal(cell.getAttribute("colSpan"), "2");
  assert.equal(serializeNode(cell), '<td colspan="2"></td>');

  const label = doc.createElement("label");
  label.setAttribute("for", "x");
  assert.equal(serializeNode(label), '<label for="x"></label>');

  // SVG / MathML 属性名大小写敏感，不能被小写
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1 1");
  assert.equal(svg.getAttribute("viewBox"), "0 0 1 1", "SVG 属性名不得被小写");
  assert.equal(svg.getAttribute("viewbox"), null);
});

test("SSR 垫片：编译产物赋的 property 必须反射回属性（否则 SSR 整条丢）", () => {
  const doc = createDocument();
  const a = doc.createElement("a");
  a.href = "/x"; // ← 编译产物对动态属性就是这种赋值
  a.className = "c";

  const input = doc.createElement("input");
  input.value = "v";
  input.checked = true;
  input.disabled = false;

  const label = doc.createElement("label");
  label.htmlFor = "s";

  const html = [a, input, label].map(serializeNode).join("");
  assert.ok(html.includes('href="/x"'), html);
  assert.ok(html.includes('class="c"'), html);
  assert.ok(html.includes('value="v"'), html);
  assert.ok(html.includes('checked=""'), html);
  assert.ok(!html.includes("disabled"), "disabled=false 不应出现在产物里：" + html);
  assert.ok(html.includes('for="s"'), html);
});

// ---------------------------------------------------------------------------
// 5. SSR 端到端：同一份编译产物，动态属性不许丢
// ---------------------------------------------------------------------------

test("SSR 端到端：动态 href / value / checked 保留，静态 htmlFor 归一为 for", async () => {
  const { mod } = await loadModule(
    `
    import { signal } from "plain";
    export const v = signal(7);
    export function App() {
      return <div>
        <a href={"/x/" + v()}>d</a>
        <input value={v()} checked={true} disabled={false} />
        <label htmlFor="s">s</label>
      </div>;
    }
    `,
    "attrssr"
  );
  const html = renderToStringSync(mod.App);
  assert.ok(html.includes('<a href="/x/7"'), "动态 href 不得丢：" + html);
  assert.ok(html.includes('value="7"'), "动态 value 不得丢：" + html);
  assert.ok(html.includes(' checked=""'), "动态 checked 不得丢：" + html);
  assert.ok(!html.includes("disabled"), html);
  assert.ok(html.includes('<label for="s">'), "htmlFor 必须归一为 for：" + html);
  assert.ok(!html.includes("htmlFor"), html);
});
