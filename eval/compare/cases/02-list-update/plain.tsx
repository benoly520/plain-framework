// Plain 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { signal } from "plain";

export function App() {
  const items = signal(["a", "b"]);
  const draft = signal("");

  const add = () => {
    const text = draft().trim();
    if (!text) return;
    items.set([...items(), text]);
    draft.set("");
  };

  return (
    <div>
      <ul>
        {items().map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <p>共 {items().length} 项</p>
      <input value={draft()} onInput={(e) => draft.set(e.target.value)} />
      <button onClick={add}>添加</button>
      <button onClick={() => items.set(items().slice(0, -1))}>删除末尾</button>
    </div>
  );
}
