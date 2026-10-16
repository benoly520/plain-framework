// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { signal, computed } from "plain";

export const todos = signal([
  { text: "写代码", done: false },
  { text: "写测试", done: true },
]);

export function toggle(i) {
  todos.set(
    todos().map((t, j) => (i === j ? { ...t, done: !t.done } : t))
  );
}

export function App() {
  const doneCount = computed(() => todos().filter((t) => t.done).length);
  return (
    <div>
      <ul>
        {todos().map((t, i) => (
          <li key={t.text}>{t.text}</li>
        ))}
      </ul>
      <span id="done">{doneCount()}</span>
    </div>
  );
}
