// SSR 入口：只导出根组件。
//
// 服务端用它渲染成 HTML（`renderToStringWithData`，由 ssrMiddleware 调用）——
// 这里**不 import entry-client**，所以 SSR 产物不会去碰浏览器侧的注水逻辑。
export { App } from "./app";
