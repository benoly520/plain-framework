// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { signal } from "plain";

let nextId = 3;

export const items = signal([
  { id: 1, text: "a", done: false },
  { id: 2, text: "b", done: false },
]);

export function toggle(id) {
  items.set(items().map((it) => (it.id === id ? { ...it, done: !it.done } : it)));
}

export function prepend(text) {
  items.set([{ id: nextId++, text, done: false }, ...items()]);
}

export function App() {
  return (
    <ul>
      {items().map((it) => (
        <li key={it.id} class={it.done ? "done" : ""}>
          {it.text}
        </li>
      ))}
    </ul>
  );
}
