// Plain 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { signal, computed } from "plain";

export function App() {
  const count = signal(0);
  const doubled = computed(() => count() * 2);
  return (
    <div>
      <button onClick={() => count.set(count() + 1)}>加一</button>
      <p>计数 {count()} / 两倍 {doubled()}</p>
    </div>
  );
}
