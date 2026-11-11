# Plain Framework 源码与项目评估

审查日期：2026-11-10。仓库：https://github.com/benoly520/plain-framework

固定版本：`c12f0d5a7db90dd64eb3779f3e8cc892333e5e58`，package.json 为 `0.5.0`。

## 总体判断

这是一个有明确设计取舍、工具链投入较多的早期前端框架。最有价值的是把 AI 常见错误转为结构化诊断、构建期检查和可执行评测；编译到 DOM 与 signals 本身则属于已有技术路线。适合学习、实验和可控试点，目前不建议直接承载关键生产业务。

决定这一判断的不是关注者数量，而是实际复现的服务端剥离遗漏、异步状态错误、调度中间态、生命周期泄漏和集成路径缺陷。

## 审查范围与验证方式

- 阅读并抽查 README、AGENTS、package.json、tsconfig、SECURITY、CI、覆盖率配置、评测结果、基准说明，以及 compiler、manifest、schema、lint、CLI、Vite 插件、signal、DOM、resource/RPC、Context、router、SSR 上下文和服务端实现等关键源码。
- Git clone 与完整归档下载未完成；使用固定提交的原始文件逐项读取。因此这是跨关键模块的审查，不是全仓逐文件审计。
- 使用本机 Node `24.18.1`、TypeScript `6.0.3` 对已取到的源码进行纯转译，再运行用例。没有修改被测实现逻辑。这不是项目锁文件定义的完整安装环境，也没有完成全量类型检查。
- 仓库原有 `test/server.test.mjs` 的 **21/21** 项通过；仅将测试的 `../dist/` 导入路径改为本地审查产物目录。
- 另编写最小用例验证下列问题。RPC 响应丢失用例使用 mock fetch；`serve()` 路由问题通过本地真实 HTTP 请求验证。
- 未跑全量测试、浏览器 E2E、覆盖率与运行时性能基准；README 的覆盖率数字不作为本次独立验证结果。

## 架构评价

| 层 | 实现 | 评价 |
|---|---|---|
| 编译器 | TypeScript AST 分析、源码切片替换、输出自检 | 容易追踪输出，但支持的 JSX 形状受限，诊断与发射逻辑需要保持一致 |
| 响应式 | signal 订阅集合、同步 effect、eager computed、batch | 内核易读，但调度一致性和 owner 生命周期仍有缺口 |
| DOM | 文本节点、注释锚点区间、条件分支、列表行 signal/Proxy | 避免通用虚拟 DOM；keyed 行复用与回收已有实际实现 |
| 服务端 | server 函数提取、manifest、RPC、SSR DOM shim | 端到端方案明确，但静态识别和生产接线仍未完全封闭 |
| SSR | AsyncLocalStorage 请求上下文、pending 资源、数据种入 | 已考虑并发隔离，比仅替换全局 document 的演示实现完整 |
| 工具链 | lint、自动修复、结构化错误、schema、CLI、MCP/LSP 入口 | 是项目最值得发展的差异化方向；schema 对无法解析的类型明确标注未知 |

它在技术路线上的相近参照是 Solid 一类编译式细粒度响应框架。不能仅以“没有虚拟 DOM”推导它比 React/Vue 快，更不能从最小计数器包体积推导复杂业务性能。

## 已复现的问题

### 1. server 改名导入绕过物理剥离，且 lint 不报错（优先级高）

```js
import { server as backend } from "plain";
export const load = backend(() => {
  const key = "PRIVATE_MARKER";
  return key.length;
});
```

实际结果：`check()` 返回空数组；`compile()` 的 `serverFunctions.length` 为 0；客户端编译输出保留 `PRIVATE_MARKER`。对照组使用原名 `server(...)`，产生 1 个 handler，客户端输出不含标记。

原因是编译器只比较调用表达式标识符的文本是否为 `server`，没有解析它对应的 import binding。运行时 `server(fn)` 又直接返回 fn，没有在遗漏编译时阻止客户端执行。

这证明编译输出存在遗漏剥离的路径；没有声称已验证某个部署中的真实密钥泄漏。若函数体包含敏感字面量或服务端业务逻辑且被保留进入应用，风险就具有现实意义。建议解析导入绑定与别名，对无法安全识别的用法构建失败，并增加客户端产物扫描。

[编译器定位](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/src/compiler/index.ts#L207)

### 2. resource.refetch 的竞态与错误状态（优先级高）

自动请求使用 `seq/ticket` 丢弃过期响应，手动 `refetch()` 另走一套逻辑，没有相同保护。

- 两次手动刷新，第二次先完成写入 `new`，第一次后完成最终覆盖成 `old`。
- 手动刷新失败并捕获返回 Promise 的拒绝后，`loading()` 仍为 true，`error()` 仍为空。

建议自动请求、手动刷新与销毁统一经过同一个请求状态机，明确取消、过期、失败和清理语义。

[源码定位](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/src/runtime/async.ts#L99)

### 3. 派生状态更新暴露不一致的中间态

设 `a = computed(() => source() * 2)`，`b = computed(() => source() * 3)`，effect 同时读取 a、b。将 source 从 1 改为 2，观察序列为：

```text
[2,3] → [4,3] → [4,6]
```

中间的 `[4,3]` 是新旧派生结果混用。对于 DOM 显示，最终画面可能正确；对于请求、校验或其他副作用，中间状态已经被执行。建议明确调度一致性承诺，并补充菱形依赖、链式 computed 和批处理组合测试。

[源码定位](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/src/runtime/signal.ts#L179)

### 4. effect 重跑期间新建的子 effect 可逃出作用域

在 createScope 中建立父 effect，父 effect 内建立子 effect。触发父 effect 重跑，再 dispose 外层 scope，之后修改子 effect 的依赖，子 effect 仍执行一次。

原因是 effect 重跑恢复了 activeEffect，但没有恢复创建它时的 activeOwner。新建立的子 effect 和清理注册可能失去所属作用域。建议将 owner 恢复、子作用域回收与异常处理作为同一个生命周期问题解决。

[源码定位](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/src/runtime/signal.ts#L54)

### 5. SSR 查询参数丢失、缓存混用

`ssrMiddleware` 文档称按完整 URL（含 query）缓存，实际先 `.split("?")[0]`，再把该值用于渲染、缓存和并发去重。

用例请求 `/search?q=a` 与 `/search?q=b`，两次都返回 `/search:1`，第二次没有独立渲染，渲染上下文也收不到查询参数。建议分开使用 pathname（路由判断）与完整请求 URL（渲染和缓存身份）。若以后支持用户态页面，缓存还需显式区分身份等变化维度。

[源码定位](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/src/server/index.ts#L317)

### 6. RPC 批处理的集成与重试问题

- `rpcMiddleware` 支持 `/_plain/rpc/batch`，但 `serve()` 只把精确等于单条 endpoint 的 URL 交给它。本地 HTTP 实测单条返回 200，批量返回 404。客户端虽会退化为逐条请求，但批处理没有兑现，反而多一次失败请求。
- 批量请求失败后无条件重放单条请求。在 mock 中模拟“服务端已执行两次写操作，但响应丢失”，最终写操作被执行 4 次。这里证明的是协议的重复执行风险，不是声称已发生真实业务损失。

建议补齐生产路由接线；降级只在能确定未执行的协议情形使用，写操作引入幂等键或明确的重试策略。

[生产路由](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/src/server/index.ts#L214) · [重试逻辑](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/src/runtime/async.ts#L186)

### 7. SSR 模板替换会解释用户文本中的替换指令

`renderPage` 使用字符串作为 `String.replace` 的 replacement。应用 HTML 为 `<p>$&</p>` 时，结果变成 `<p><!--plain-ssr--></p>`，没有保留原文本。应使用返回字符串的 replacement 回调，避免 `$&`、`$\`` 等特殊语义。

[源码定位](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/src/server/index.ts#L398)

### 8. 编译器给出的修复建议仍然无法编译

不支持的 JSX 短路表达式诊断建议改为 `const node = cond || <a/>;` 再插值。但把该建议放进组件后，仍然得到 `PLAIN_E1001`，因为 JSX 作为变量初值也不被支持。

对主打 AI 可修复性的项目，诊断中的示例应进入可执行测试，保证“按提示修改”确实成功。

[源码定位](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/src/compiler/index.ts#L1876)

## 工程质量与产品判断

优点：结构化错误码、真实的回归测试、对 key 与 index 等不支持组合明确拒绝、属性归一化集中维护、SSR 请求上下文隔离、产物自检，以及对评测效度的坦诚披露。这些都具有实际工程价值。

代价：JSX 属性展开被禁、组件体只运行一次、props 不能随意解构或快照、children 需要显式调用、keyed 列表不能直接使用 index、server 函数名需全局唯一。它缩小了可写语法与行为范围，但使用者仍要学习这些限制。API 少不等于心智负担必然低。

测试与维护方面：CI 有构建、单测、覆盖率门槛与评测 harness 自检；真实浏览器 E2E 只在手动 workflow_dispatch 时运行。`.c8rc.json` 的 `all:false` 也意味着不能把声明的覆盖率直接理解为仓库所有源码都已纳入分母。原有服务端测试全部通过而组合缺陷仍可复现，是增加集成矩阵的直接理由。

文档存在漂移：SECURITY 仍写支持 `0.3.x`，package 已是 `0.5.0`；部分 README 测试/任务数量与后续评测记录不一致。对依赖文档引导 AI 的框架，这类漂移影响比一般项目更大。

[CI](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/.github/workflows/ci.yml) · [评测结果](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/eval/RESULTS.md) · [基准说明](https://github.com/benoly520/plain-framework/blob/c12f0d5a7db90dd64eb3779f3e8cc892333e5e58/benchmark/README.md)

截至本次读取，仓库创建于 2026-10-07，最近推送为 2026-11-09，许可证 MIT。开发活跃，但公开历史很短；不能从短期迭代推断长期兼容与维护能力。现有 AI 对比记录样本小且作者主动标注协议污染，不能证明优于 React。浏览器运行时性能基准在文档中仍列为待补。

## 建议的推进顺序

1. 优先封住 server 编译遗漏，修复异步状态、生命周期和写操作重试问题。
2. 明确响应式调度语义，并把查询参数、批处理、SSR、异常和清理组合成集成测试。
3. 把文档示例、诊断修复建议和版本声明纳入自动验证；让浏览器 E2E 成为正常 PR 门槛。
4. 用两三个真实业务持续使用，建立可复现的浏览器性能与内存基准。
5. 再以固定模型、固定提示词、充分样本和独立上下文验证“AI 更容易一次写对”。

选型建议：学习和研究值得读；非关键内部工具可以限定范围试点；需要成熟组件生态、严格兼容承诺或复杂 SSR 的核心业务，当前仍应优先考虑成熟框架。
