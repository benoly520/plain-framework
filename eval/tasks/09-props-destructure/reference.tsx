// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { signal, resolve } from "plain";

export function Card(props) {
  return <h2>{resolve(props.title)}</h2>;
}

export function App() {
  const title = signal("Hello");
  return (
    <div>
      <Card title={title()} />
      <button onClick={() => title.set("World")}>重命名</button>
    </div>
  );
}
