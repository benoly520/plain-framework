import { signal, mount } from "plain";

function App() {
  // 唯一的状态原语：signal。读 xxx()，写 xxx.set(v)
  const count = signal(0);
  return (
    <main>
      <h1>__PROJECT_NAME__</h1>
      <button onClick={() => count.set(count() + 1)}>点击了 {count()} 次</button>
    </main>
  );
}

mount("#app", App());
