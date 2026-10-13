// React 参考实现（自检 harness：node eval/compare/run.mjs --reference）
import { useEffect, useState } from "react";

let nth = 0;
const fetchData = () =>
  new Promise((resolve) => setTimeout(() => resolve(`数据${++nth}`), 10));

export function App() {
  const [tick, setTick] = useState(0);
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null); // 回到加载中
    fetchData().then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, [tick]);

  return (
    <div>
      {data === null ? <p>加载中</p> : <p>{data}</p>}
      <button onClick={() => setTick(tick + 1)}>重新加载</button>
    </div>
  );
}
