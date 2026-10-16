// 控制流单测：渲染函数 / 列表回调里的 if · else · try/catch · 循环 · switch · 就地小渲染函数
// 这些形状在旧实现里会漏编译（产物残留 JSX -> PLAIN_E1003）或被静默丢掉（只留最后一个分支），
// 所以这里不看产物字符串，直接跑编译结果断言 DOM。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { compile } from "../dist/compiler/index.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_URL = pathToFileURL(path.join(ROOT, "dist/runtime/index.js")).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-cf-"));

/** 剥 TS 类型 -> Plain 编译 -> 落盘 -> 动态 import（与 keyed.test.mjs 同一套跑法） */
async function compileModule(tsx, name) {
  const stripped = await esbuild.transform(tsx, {
    loader: "tsx",
    jsx: "preserve",
    target: "es2022",
    format: "esm",
  });
  const out = compile(stripped.code, `${name}.jsx`);
  const code = out.code.replace(/from\s+["']plain["']/g, `from "${RUNTIME_URL}"`);
  const file = path.join(TMP, `${name}.mjs`);
  fs.writeFileSync(file, code);
  const mod = await import(pathToFileURL(file).href + `?v=${Date.now()}`);
  return { mod, code };
}

/** 编译 + 挂载组件，返回容器（组件是普通函数，返回 Fragment，直接 appendChild） */
async function render(tsx, name) {
  const { mod, code } = await compileModule(tsx, name);
  const box = document.createElement("div");
  document.body.appendChild(box);
  box.appendChild(mod.C());
  return { box, code };
}

/** 列表数据：一条 ok、一条不 ok */
const ROWS = `
  import { signal } from "plain";
  export const rows = signal([
    { ok: true, tag: "li", list: ["", "a"] },
    { ok: false, tag: "span", list: [] },
  ]);`;

const textsOf = (box, sel) =>
  Array.from(box.querySelectorAll(sel)).map((el) => el.textContent);

test("列表回调：if / else 两个分支都按条件渲染（不是只渲染最后一个 return）", async () => {
  const { box, code } = await render(
    `${ROWS}
    export function C() {
      return <ul>{rows().map((x) => {
        if (x.ok) return <li>yes</li>;
        else return <li>no</li>;
      })}</ul>;
    }`,
    "cb-if-else"
  );
  assert.ok(!/<li>/.test(code), "产物不该残留 JSX：\n" + code);
  assert.deepEqual(textsOf(box, "li"), ["yes", "no"]);
});

test("列表回调：try / catch 里的提前 return", async () => {
  const { box, code } = await render(
    `${ROWS}
    export function C() {
      return <ul>{rows().map((x) => {
        try {
          if (!x.ok) throw new Error("boom");
          return <li>ok</li>;
        } catch (e) {
          return <li>err</li>;
        }
      })}</ul>;
    }`,
    "cb-try"
  );
  assert.ok(!/<li>/.test(code), "产物不该残留 JSX：\n" + code);
  assert.deepEqual(textsOf(box, "li"), ["ok", "err"]);
});

test("列表回调：for-of 里的提前 return 与兜底 return", async () => {
  const { box, code } = await render(
    `${ROWS}
    export function C() {
      return <ul>{rows().map((x) => {
        for (const y of x.list) {
          if (y !== "") return <li>{y}</li>;
        }
        return <li>none</li>;
      })}</ul>;
    }`,
    "cb-for-of"
  );
  assert.ok(!/<li>/.test(code), "产物不该残留 JSX：\n" + code);
  assert.deepEqual(textsOf(box, "li"), ["a", "none"]);
});

test("列表回调：switch 分支里的 return", async () => {
  const { box, code } = await render(
    `${ROWS}
    export function C() {
      return <ul>{rows().map((x) => {
        switch (x.tag) {
          case "li": return <li>li</li>;
          default: return <li>other</li>;
        }
      })}</ul>;
    }`,
    "cb-switch"
  );
  assert.ok(!/<li>/.test(code), "产物不该残留 JSX：\n" + code);
  assert.deepEqual(textsOf(box, "li"), ["li", "other"]);
});

test("列表回调：就地定义的小渲染函数（函数声明 / 箭头）也会被编译", async () => {
  const { box, code } = await render(
    `${ROWS}
    export function C() {
      return <ul>{rows().map((x) => {
        function tag() { return <b>{x.tag}</b>; }
        const text = () => <i>{x.ok ? "on" : "off"}</i>;
        return <li>{tag()}{text()}</li>;
      })}</ul>;
    }`,
    "cb-local-fn"
  );
  assert.ok(!/<b>/.test(code) && !/<i>/.test(code), "产物不该残留 JSX：\n" + code);
  assert.deepEqual(textsOf(box, "li"), ["lion", "spanoff"]);
});

test("列表回调：就地定义的组件函数（首字母大写）被当组件调用", async () => {
  const { box } = await render(
    `${ROWS.replace('import { signal } from "plain";', 'import { signal, resolve } from "plain";')}
    export function C() {
      return <ul>{rows().map((x) => {
        const Row = (p) => <li>{resolve(p.v)}</li>;
        return <Row v={x.tag} />;
      })}</ul>;
    }`,
    "cb-local-component"
  );
  assert.deepEqual(textsOf(box, "li"), ["li", "span"]);
});

test("列表回调：`if (!x) return null` 的项渲染为空，不留多余节点", async () => {
  const { box } = await render(
    `${ROWS}
    export function C() {
      return <ul>{rows().map((x) => {
        if (!x.ok) return null;
        return <li>{x.tag}</li>;
      })}</ul>;
    }`,
    "cb-null"
  );
  assert.deepEqual(textsOf(box, "li"), ["li"]);
});

test("渲染函数 prop：if / else 里的提前 return 不被静默丢掉", async () => {
  const { box } = await render(
    `function Box(props) { return <div>{props.render(true)}{props.render(false)}</div>; }
     export function C() {
       return <Box render={(ok) => {
         if (ok) return <p>yes</p>;
         return <p>no</p>;
       }} />;
     }`,
    "prop-if-else"
  );
  assert.equal(box.textContent, "yesno");
});

test("渲染函数 prop：三元 / .map 体同样是合法的渲染函数", async () => {
  const { box, code } = await render(
    `function Box(props) { return <div>{props.render()}</div>; }
     export function C() {
       return <Box render={() => (<ul>{["a", "b"].map((v) => <li>{v}</li>)}</ul>)} />;
     }`,
    "prop-map"
  );
  assert.ok(!/<li>/.test(code), "产物不该残留 JSX：\n" + code);
  assert.deepEqual(textsOf(box, "li"), ["a", "b"]);
});
