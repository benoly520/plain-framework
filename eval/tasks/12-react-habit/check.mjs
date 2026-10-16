// 验收断言（AI 看不到这个文件）
//
// 靶子：把「派生值」又存成一份独立状态（React 的 useState 快照习惯）。
// 两份状态会不同步 —— 这是「同一事实有两种表示」的经典 bug。
// 也顺便测：toggle 更新时是否用了不可变更新（就地改不会触发更新）。
import assert from "node:assert/strict";

export default async function check({ mod, mount }) {
  const { box } = mount();
  box.appendChild(mod.App());
  const lis = () => Array.from(box.querySelectorAll("li"));
  const done = () => box.querySelector("#done").textContent.trim();

  assert.equal(lis().length, 2, "初始应有 2 项");
  assert.equal(done(), "1", "初始已完成数应为 1（写测试已完成）");

  // 把第 0 项标记完成 -> 变成 2
  mod.toggle(0);
  assert.equal(
    done(),
    "2",
    "toggle 后已完成数必须立刻变成 2（单独存一份数字状态会停在 1）"
  );

  // 再翻回去 -> 1
  mod.toggle(0);
  assert.equal(done(), "1", "再 toggle 一次应回到 1");

  // 列表内容不能被破坏（就地改会累积脏数据）
  assert.deepEqual(
    lis().map((li) => li.textContent.trim()),
    ["写代码", "写测试"],
    "列表文本应保持正确"
  );
}
