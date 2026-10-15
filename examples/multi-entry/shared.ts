// 被两个入口共享的模块：一个共享组件 + 一个共享的 server() 函数。
// server() 只在这里定义一次，因此函数名全局唯一，不会触发多入口清单冲突。
import { server } from "plain";

// 共享的页脚组件（普通组件，纯客户端）
export function SiteFooter() {
  return <footer class="foot">© Plain 多入口示例 · 由 server() 提供站点信息</footer>;
}

// 站点元信息：编译后客户端只剩 RPC 桩，函数体物理搬到 .plain/server.mjs
export const getSiteMeta = server(() => ({
  name: "Plain Demo",
  version: "0.3.0",
}));
