// Plain 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { signal, resource } from "plain";

let nth = 0;
const fetchData = () =>
  new Promise((resolve) => setTimeout(() => resolve(`数据${++nth}`), 10));

export function App() {
  const tick = signal(0);
  // 在资源函数里读一下 tick：依赖被收集之后，点「重新加载」就能重新拉取
  const r = resource(() => {
    tick();
    return fetchData();
  });

  return (
    <div>
      {r.loading() ? <p>加载中</p> : <p>{r.data()}</p>}
      <button onClick={() => tick.set(tick() + 1)}>重新加载</button>
    </div>
  );
}
