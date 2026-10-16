// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { signal } from "plain";

export const input = signal("<b>hi</b>");

export function App() {
  return (
    <div>
      <div id="out">{input()}</div>
      <input value={input()} onInput={(e) => input.set(e.target.value)} />
    </div>
  );
}
