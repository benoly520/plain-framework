// 验收断言（AI 看不到这个文件）
//
// 靶子：effect 写成 async —— `effect(async () => { await … })`。
// 依赖收集在第一个 await 之后失效，而且 effect 的清理返回值被 Promise 包住、拿不到。
// 表现：异步回调里改状态时，effect 不再重新追踪依赖，或清理函数不执行。
import assert from "node:assert/strict";

export default async function check({ mod, mount, tick }) {
  const { box } = mount();
  box.appendChild(mod.App());
  const p = () => box.querySelector("p");

  assert.ok(p(), "应渲染出一个 <p>");
  assert.equal(p().textContent.trim(), "加载中", "初始应为「加载中」");

  // 等异步副作用跑完（10ms 定时器 + 余量）
  await new Promise((r) => setTimeout(r, 60));
  if (tick) await tick();

  assert.equal(
    p().textContent.trim(),
    "完成",
    "约 10ms 后必须自动变成「完成」（async effect 会因为依赖收集失效而不更新 / 抛错）"
  );
}
