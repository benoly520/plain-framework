// React 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { useState } from "react";

export function Card({ title }) {
  return <h2>{title}</h2>;
}

export function App() {
  const [title, setTitle] = useState("Hello");
  const [draft, setDraft] = useState("");

  return (
    <div>
      <Card title={title} />
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={() => setTitle(draft)}>重命名</button>
    </div>
  );
}
