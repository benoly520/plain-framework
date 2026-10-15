// 控制台入口（独立 HTML）：演示跨入口共享的 server() 函数 + resource 取首屏数据。
import { resource, mount } from "plain";
import { getSiteMeta, SiteFooter } from "./shared";

function Dashboard() {
  // getSiteMeta 是 shared.ts 里的 server() 函数，这里只声明式取数据。
  // 客户端拿到的是 Promise 桩，resource 负责 loading / data / error 三态。
  const meta = resource(() => getSiteMeta());
  return (
    <div class="page">
      <h1>控制台</h1>
      <p>
        {meta.loading() ? "加载中…" : meta.error() ? "出错了" : `站点名：${meta.data()?.name}`}
      </p>
      <SiteFooter />
    </div>
  );
}

mount("#dashboard", Dashboard());
