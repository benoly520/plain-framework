# Plain 多入口示例

演示**多 HTML 入口 + 跨入口共享 `server()` 函数**。框架侧已保证多入口的服务端清单不会
静默互相覆盖（跨文件同名 `server()` 会在构建期报冲突），打包层（多个 HTML / shared chunk）
完全交给 Vite，框架不介入。

## 运行

```bash
# 在仓库根目录先编译框架
pnpm run build

# 开发：两个入口各自是独立页面
npx vite --config examples/multi-entry/vite.config.js
#   打开 http://localhost:5173/index.html      首页
#   打开 http://localhost:5173/app.html        控制台（含一次 server() RPC）

# 生产构建：rollupOptions.input 里声明的两个 HTML 各出一份产物
npx vite build --config examples/multi-entry/vite.config.js
```

## 这份示例证明了什么

- 多入口的 HTML / bundle 互不干扰（Vite 原生能力，框架透传）；
- 共享模块里定义的 `server()` 函数（见 `shared.ts`）只编译进**一份** `.plain/server.mjs` 清单；
- 控制台的 `resource(() => getSiteMeta())` 走的是客户端 RPC 桩，函数体不在浏览器里。

> 注意：`server()` 函数名在整个应用里必须唯一。多个入口各自定义同名函数会触发构建期冲突
> （点名两个来源文件），而不是静默互相覆盖。要共享就抽到 `shared.ts` 这类公共模块只定义一次。
