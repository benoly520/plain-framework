// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { signal } from "plain";

export const items = signal(["a", "b"]);

export function add(text) {
  items.set([...items(), text]);
}

export function removeLast() {
  items.set(items().slice(0, -1));
}

export function App() {
  return (
    <div>
      <ul>
        {items().map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <span>{items().length}</span>
    </div>
  );
}
