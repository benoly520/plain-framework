// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { signal, effect } from "plain";

export const loading = signal(true);

export function App() {
  // 副作用是同步的：异步动作写进回调，不要写成 async 函数
  effect(() => {
    if (!loading()) return;
    const t = setTimeout(() => loading.set(false), 10);
    return () => clearTimeout(t);
  });

  return <p>{loading() ? "加载中" : "完成"}</p>;
}
