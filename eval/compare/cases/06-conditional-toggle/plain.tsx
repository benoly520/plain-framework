// Plain 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { signal } from "plain";

export function App() {
  const visible = signal(false);
  return (
    <div>
      <button onClick={() => visible.set(!visible())}>
        {visible() ? "隐藏" : "显示"}
      </button>
      {visible() ? <p>现在可见</p> : null}
    </div>
  );
}
