// React 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { useState } from "react";

export function App() {
  const [items, setItems] = useState(["a", "b"]);

  return (
    <div>
      {items.length > 0 ? (
        <ul>
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : (
        <p>空</p>
      )}
      <button onClick={() => setItems(items.slice(0, -1))}>删除一个</button>
    </div>
  );
}
