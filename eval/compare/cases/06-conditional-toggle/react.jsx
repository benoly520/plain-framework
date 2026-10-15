// React 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { useState } from "react";

export function App() {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <button onClick={() => setVisible(!visible)}>
        {visible ? "隐藏" : "显示"}
      </button>
      {visible ? <p>现在可见</p> : null}
    </div>
  );
}
