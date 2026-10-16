// 验收断言（AI 看不到这个文件）
//
// 靶子：忘记调用 signal —— 写成 `{count}` 而不是 `{count()}`。
// 这是从 React/Solid 迁移最常犯的错：把「读值」当成「传值」。
// 后果是插值拿到的是 getter 函数本身，DOM 里出现函数源码字符串，且不响应更新。
import assert from "node:assert/strict";

export default async function check({ mod, mount }) {
  const { box } = mount();
  box.appendChild(mod.App());
  const btn = () => box.querySelector("button");

  assert.ok(btn(), "应渲染出一个 <button>");
  assert.equal(btn().textContent.trim(), "0", "初始文本应为 0");

  mod.inc();
  assert.equal(
    btn().textContent.trim(),
    "1",
    "inc 后文本应为 1（写成 {count} 时这里会显示函数源码或不更新）"
  );

  mod.inc();
  mod.inc();
  assert.equal(btn().textContent.trim(), "3", "再调用两次后应为 3");

  // 明确排除「把函数源码渲染出来」这种失败形态
  assert.ok(
    !/=>|function|signal/i.test(btn().textContent),
    "按钮文本里不应出现函数源码（说明忘了调用 signal）"
  );
}
