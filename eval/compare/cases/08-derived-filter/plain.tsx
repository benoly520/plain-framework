// Plain 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { signal } from "plain";

export function App() {
  const fruits = ["苹果", "香蕉", "橙子"];
  const q = signal("");
  const filtered = () => fruits.filter((f) => f.toLowerCase().includes(q().toLowerCase()));
  return (
    <div>
      <input value={q()} onInput={(e) => q.set(e.target.value)} />
      <ul>{filtered().map((f) => <li>{f}</li>)}</ul>
    </div>
  );
}
