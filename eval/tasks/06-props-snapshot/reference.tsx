// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { signal, resolve } from "plain";

export const title = signal("Hello");

export function rename(next) {
  title.set(next);
}

export function Card(props) {
  return <h2>{resolve(props.title)}</h2>;
}

export function App() {
  return <Card title={title()} />;
}
