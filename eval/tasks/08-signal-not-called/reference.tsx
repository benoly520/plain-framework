// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { signal } from "plain";

export const count = signal(0);

export function inc() {
  count.set(count() + 1);
}

export function App() {
  return <button>{count()}</button>;
}
