// React 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { useState } from "react";

export function App() {
  const [items, setItems] = useState(["a", "b"]);
  const [draft, setDraft] = useState("");

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setItems([...items, text]);
    setDraft("");
  };

  return (
    <div>
      <ul>
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <p>共 {items.length} 项</p>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={add}>添加</button>
      <button onClick={() => setItems(items.slice(0, -1))}>删除末尾</button>
    </div>
  );
}
