// Plain 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { signal, resolve } from "plain";

export function Card(props) {
  return <h2>{resolve(props.title)}</h2>;
}

export function App() {
  const title = signal("Hello");
  const draft = signal("");

  return (
    <div>
      <Card title={title()} />
      <input value={draft()} onInput={(e) => draft.set(e.target.value)} />
      <button onClick={() => title.set(draft())}>重命名</button>
    </div>
  );
}
