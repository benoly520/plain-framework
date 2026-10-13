# 安全说明

Plain 的安全模型建立在一条主轴上：**「这段代码跑在哪」是编译期决定的、结构上不可混淆的**。
本文说明这条主轴带来的保证、已知边界，以及怎么报告问题。

---

## 1. 报告漏洞

请**不要**用公开 issue 报告安全问题。发邮件到仓库维护者（见 `package.json` 的 `repository`），
或使用 GitHub 的私密漏洞报告（Security → Report a vulnerability）。

请附：复现步骤、影响范围、Plain 版本（`npx plaindev --version` 或 `package.json`）、
Node 与构建工具版本。我们会在确认后于 CHANGELOG 记一条 `security:` 说明。

**支持范围**：只覆盖最新的 minor 版本（当前 `0.3.x`）。Plain 尚在 0.x，不承诺长期支持。

---

## 2. 核心保证

### 2.1 `server()` 边界是物理的，不是约定的

`server(fn)` 的函数体在**编译期**被从客户端产物里**整段搬走**，客户端只留下
`(...args) => rpc("name", args)` 桩：

- 密钥 / 数据库连接 / 内部 API —— 写进 `server()` 函数体，就**不可能**出现在浏览器 bundle 里。
  这不是「你别写错」，而是「写错了产物里也没有」。
- 有 `test/run.mjs` 的「server() 物理剥离 + RPC 往返」用例守着这条不变量。

**边界**：`server()` 的**参数与返回值**会走 JSON-RPC，客户端能看到。别把密钥当返回值传回来。
返回值无法 JSON 序列化的形态（函数 / 类实例 / Stream）会被编译期拦下（`PLAIN_E1007`），
但**可序列化但敏感**的数据（比如整行用户记录）编译器无从判断 —— 那是应用层的取舍。

### 2.2 产物里不可能出现 `innerHTML`

Plain 的编译产物与运行时**不生成 `innerHTML` / `insertAdjacentHTML`**：

- 所有 `{expr}` 插值都走 `document.createTextNode`（客户端）与转义（SSR），不拼 HTML 字符串。
- SSR 序列化对**文本**与**属性值**都做转义（`& < > "`），见 `src/server/dom-shim.ts`。
- `src/server/dom-shim.ts` 里 `innerHTML` 的 setter **直接抛错** —— 服务端也不给这条后门。
- 契约检查把 `el.innerHTML = …` 报成 `PLAIN_E1104`（安全红线，不可自动修）。
- 有 `test/run.mjs` 的 XSS 用例守着「产物不含 innerHTML」「插值不拼字符串」。

其结果是：**用户输入进 DOM 的路径天然经过转义**，`<img src=x onerror=…>` 这类注入
在文本插值里只会显示成字面文本。

### 2.3 运行时零 `eval` / 零 `new Function`

`src/runtime/**` 与编译产物里没有 `eval` / `new Function`。也就是说，**生产环境的 CSP
不需要 `unsafe-eval`** 就能跑 Plain 应用。

---

## 3. CSP 与构建链路的注意点

### 3.1 只有 dev 的 RPC 中间件会 `new Function`（不进产物）

`src/vite/index.ts` 在 **dev** 下为了让 `/_plain/rpc` 能真正调用到 `server()` 函数，
会把函数体用 `new Function` 求值成可调用对象。要点：

- **仅 dev**。构建（build）阶段**不再求值函数体** —— 清单只需要函数体文本，
  所以 build 不碰 `new Function`（有 `test/vite-plugin.test.mjs` 的
  「build 模式不求值函数体」用例守着）。这既缩小了 CSP 面，也避免构建机执行到本
  该只跑在服务端运行时的代码。
- dev server 本来就不是安全边界（它默认只监听 localhost、且是开发用）。
  **不要把 `plaindev dev` 暴露到公网。**

### 3.2 `_plain` 命名空间

框架占用的两处运行时端点：

| 路径 | 用途 | 生产是否启用 |
| --- | --- | --- |
| `/_plain/rpc`（dev） | Vite 插件的 dev RPC 中间件 | dev 才注册；`rpc: false` 可关 |
| `/_plain/rpc`（prod） | `rpcMiddleware()` / `plaindev serve` | 用你挂的中间件时才存在 |

生产环境你自己决定要不要挂 `rpcMiddleware()`，以及挂在哪个路径、前面加哪些鉴权中间件。
**Plain 不做鉴权** —— 鉴权请在 `server()` 函数体里、或你自己的 Node 中间件里做。

### 3.3 `new Function` 的 CSP 影响（如你在 dev 用严格 CSP）

若开发环境也套了严格 CSP，dev 的 RPC 中间件需要允许 `unsafe-eval`；或设 `rpc: false`
关掉 dev RPC（代价是 dev 下点服务端函数拿不到数据）。**生产不需要**这条。

---

## 4. 已知边界（不是漏洞，但要知情）

- **`server()` 函数名全局唯一**：清单是单文件（`.plain/server.mjs`），多入口 / 多模块下
  同名会被**构建期拦下并报冲突**（`assertNoNameCollision`），不会静默覆盖。
- **SSR 注水锚点**：SSR / hydrate 用 `<!--plain-…-->` 注释作为认领锚点。若你把**用户可控的
  内容**注入成 HTML 注释并由服务端直出，理论上可能干扰锚点定位 —— 但框架本身只产出自己
  生成的锚点，用户内容走文本节点，不经过此路径。
- **契约检查是启发式的**：`PLAIN_E11xx` 是静态分析，可能误报（用
  `plain-ignore-line` 抑制）也可能漏报。它是**提高 AI 首次写对率**的护栏，**不是安全边界**。
  真正的安全不变量（服务端剥离、无 innerHTML、无 eval）由构造与测试保证，不靠 lint。
- **`plaindev serve` / `staticMiddleware` 是静态托管**：它按路径提供 `dist` 下的文件，
  带目录穿越防护（有测试），但不做鉴权 / 限流 / WAF。面向公网请放到正经的反向代理后面。

---

## 5. 威胁模型小结

| 你想防的 | Plain 的应对 | 靠什么保证 |
| --- | --- | --- |
| 密钥泄漏到浏览器 | `server()` 编译期物理剥离 | 编译构造 + 集成测试 |
| XSS（用户输入注入 HTML） | 不生成 innerHTML；插值走文本节点 + 转义 | 编译构造 + 运行时 + SSR 转义 |
| 生产 CSP 被迫开 `unsafe-eval` | 运行时 / 产物零 `eval` / `new Function` | 构造 + 测试 |
| 客户端伪造服务端数据 | 权威校验写在 `server()` 函数体内 | **你的应用代码**（框架不代替） |
| 鉴权 / 限流 / 会话 | 不在框架职责内 | 你的中间件 / 反向代理 |
