// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { signal, computed } from "plain";

export const count = signal(0);
export const doubled = computed(() => count() * 2);

export function App() {
  return (
    <button onClick={() => count.set(count() + 1)}>
      点我 {count()}（翻倍 {doubled()}）
    </button>
  );
}
