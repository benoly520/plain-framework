// 首页入口（独立 HTML）：纯客户端渲染，演示多入口互不干扰。
import { signal, mount } from "plain";
import { SiteFooter } from "./shared";

function Landing() {
  const visits = signal(0);
  return (
    <div class="page">
      <h1>Plain 多入口示例 · 首页</h1>
      <p>这是独立的 HTML 入口，与控制台页面各打各的 bundle。</p>
      <button
        class="btn"
        onClick={() => visits.set(visits() + 1)}
      >
        点我计数（{visits()}）
      </button>
      <SiteFooter />
    </div>
  );
}

mount("#landing", Landing());
