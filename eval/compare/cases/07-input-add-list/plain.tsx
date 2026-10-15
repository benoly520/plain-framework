// Plain 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { signal } from "plain";

export function App() {
  const text = signal("");
  const items = signal([]);
  const add = () => {
    const v = text().trim();
    if (!v) return;
    items.set([...items(), v]);
    text.set("");
  };
  return (
    <div>
      <input value={text()} onInput={(e) => text.set(e.target.value)} />
      <button onClick={add}>添加</button>
      <ul>{items().map((t) => <li>{t}</li>)}</ul>
    </div>
  );
}
