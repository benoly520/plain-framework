// React 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { useState } from "react";

export function App() {
  const fruits = ["苹果", "香蕉", "橙子"];
  const [q, setQ] = useState("");
  const filtered = fruits.filter((f) =>
    f.toLowerCase().includes(q.toLowerCase())
  );
  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} />
      <ul>{filtered.map((f) => <li key={f}>{f}</li>)}</ul>
    </div>
  );
}
