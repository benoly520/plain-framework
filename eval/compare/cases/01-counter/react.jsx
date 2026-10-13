// React 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  const doubled = count * 2;
  return (
    <div>
      <button onClick={() => setCount(count + 1)}>加一</button>
      <p>计数 {count} / 两倍 {doubled}</p>
    </div>
  );
}
