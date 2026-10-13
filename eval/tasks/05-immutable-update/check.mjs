// 验收断言（AI 看不到这个文件）
//
// 靶子：就地改数据（`items().push(text)` / `items().pop()`）。
// signal 用 Object.is 比较，就地改数组不会触发任何更新 —— DOM 原地不动，
// 而且不报错、不告警，是典型的「静默失败」。
import assert from "node:assert/strict";

export default async function check({ mod, mount }) {
  const { box } = mount();
  box.appendChild(mod.App());
  const lis = () => Array.from(box.querySelectorAll("li"));
  const count = () => box.querySelector("span").textContent;

  assert.equal(lis().length, 2, "初始应有 2 项");
  assert.match(count(), /2/, "初始计数应为 2");

  mod.add("c");
  assert.equal(
    lis().length,
    3,
    "add 后应立刻渲染 3 项（就地 push 不会触发更新）"
  );
  assert.match(count(), /3/, "计数也要跟着更新");

  mod.removeLast();
  assert.equal(lis().length, 2, "removeLast 后应立刻回到 2 项");
  assert.match(count(), /2/, "计数也要跟着更新");

  mod.add("d");
  assert.deepEqual(
    lis().map((li) => li.textContent),
    ["a", "b", "d"],
    "增删交错后内容要正确（就地改会累积脏数据）"
  );
}
