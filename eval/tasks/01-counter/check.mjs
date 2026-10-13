// 验收断言（AI 看不到这个文件）
import assert from "node:assert/strict";

export default async function check({ mod, mount }) {
  const { box } = mount();
  box.appendChild(mod.App());

  assert.match(box.textContent, /点我\s*0/, "初始文本应为「点我 0」");
  assert.match(box.textContent, /翻倍\s*0/, "初始派生值应为 0");

  const btn = box.querySelector("button");
  assert.ok(btn, "应渲染出 <button>");

  btn.click();
  assert.match(box.textContent, /点我\s*1/, "点击后计数应为 1");
  assert.match(box.textContent, /翻倍\s*2/, "点击后派生值应为 2");

  assert.equal(mod.count(), 1, "count 应可从外部读到");
  assert.equal(mod.doubled(), 2, "doubled 应是响应式派生值");
}
