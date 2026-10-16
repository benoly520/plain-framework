// 验收断言（AI 看不到这个文件）
//
// 靶子：用 innerHTML 渲染动态内容 —— `el.innerHTML = input()`。
// 这是 XSS 的入口（用户输入被当 HTML 解析），也绕开了框架的文本绑定。
// Plain 的产物里**不应出现 innerHTML**（构建期也会报 PLAIN_E1104）。
import assert from "node:assert/strict";

export default async function check({ mod, mount }) {
  const { box } = mount();
  box.appendChild(mod.App());
  const out = () => box.querySelector("#out");

  assert.ok(out(), "应渲染出 #out");
  assert.equal(out().textContent.trim(), "<b>hi</b>", "初始应原样显示尖括号文本");
  assert.equal(
    out().querySelector("b"),
    null,
    "尖括号必须是文本，不能生成真的 <b> 元素（说明用了 innerHTML）"
  );

  // 换成一段明显的注入 payload（Plain 的状态在模块作用域，外部可直接写）
  mod.input.set('<img src=x onerror="window.__xss=1">');
  assert.equal(
    out().textContent.trim(),
    '<img src=x onerror="window.__xss=1">',
    "输入内容应原样作为文本显示"
  );
  assert.equal(out().querySelector("img"), null, "不能真的创建 <img>（XSS 面）");
  assert.equal(globalThis.__xss, undefined, "注入不应被执行");
}
