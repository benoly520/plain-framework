// 客户端入口：注水接管服务端渲染出的 DOM（节点身份不变，事件与响应式随之绑上）
//
// `hydrate` 会自己从页面里的 `<script id="plain-data">` 读回首屏数据载荷，
// 按 resource 的调用点配对种入 —— 所以这里不需要手动传任何数据。
import { hydrate } from "plain";
import { App } from "./app";

const container = document.getElementById("app");
if (!container) {
  throw new Error("[plain] 找不到 #app 容器：检查 index.html 里有没有它");
}

hydrate(container, App);
