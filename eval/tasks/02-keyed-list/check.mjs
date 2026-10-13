// 验收断言（AI 看不到这个文件）
import assert from "node:assert/strict";

export default async function check({ mod, mount }) {
  const { box } = mount();
  box.appendChild(mod.App());
  const lis = () => Array.from(box.querySelectorAll("li"));

  assert.equal(lis().length, 2, "初始应有 2 行");
  const [a, b] = lis();
  assert.equal(a.textContent, "a");

  // 不可变更新 + 行内响应式
  mod.toggle(1);
  assert.equal(lis()[0].className, "done", "toggle 后 class 应为 done");
  assert.equal(lis()[0], a, "toggle 应就地更新，节点被复用");
  assert.equal(lis()[1].className, "", "第二行不应受影响");

  // 关键要求：头部插入后节点身份跟着数据走
  mod.prepend("z");
  assert.equal(lis().length, 3, "插入后应有 3 行");
  assert.equal(lis()[0].textContent, "z", "新项应在头部");
  assert.equal(
    lis()[1],
    a,
    "id=1 的 DOM 节点必须是同一个对象（keyed 复用）"
  );
  assert.equal(lis()[2], b, "id=2 的 DOM 节点必须是同一个对象");
  assert.equal(lis()[1].textContent, "a", "节点内容必须还是它自己的数据");
}
