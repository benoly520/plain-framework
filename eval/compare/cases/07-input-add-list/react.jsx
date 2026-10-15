// React 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { useState } from "react";

export function App() {
  const [text, setText] = useState("");
  const [items, setItems] = useState([]);
  const add = () => {
    const v = text.trim();
    if (!v) return;
    setItems([...items, v]);
    setText("");
  };
  return (
    <div>
      <input value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={add}>添加</button>
      <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}
