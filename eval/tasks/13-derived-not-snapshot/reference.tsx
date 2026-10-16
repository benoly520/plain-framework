// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { signal } from "plain";

export const first = signal("Ada");
export const last = signal("Lovelace");

export function App() {
  return <p id="full">{last() + ", " + first()}</p>;
}
