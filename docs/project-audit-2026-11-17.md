# Plain 项目问题与改进分析

> 分析日期：2026-11-17 · 代码基线：v0.7.0（含 0.6.0 历史合并后）
> 范围：主体为**只读分析**；P0-5 / P0-6 为 2026-11-19 补录的已修复项。行号以当前 `src/` 为准，
> 可能随代码演进漂移。
> 分级：P0 安全/正确性 · P1 承诺与一致性 · P2 性能与架构 · P3 工程与维护。

## 结论摘要

| 级别 | 数量 | 主题 |
| --- | --- | --- |
| P0 | 6 | SSR 缓存隔离、流式错误状态、RPC 边界防护、错误信息泄露、hydration 浏览器兼容、嵌套锚点配对（后两项已修复） |
| P1 | 7 | 文档与实现不符、公开 API 面、编译器识别不一致、版本/文档漂移 |
| P2 | 7 | 调度器开销、computed 求值策略、静态服务、CI 口径、评测趋势 |
| P3 | 3 | 本地缓存目录、版本号单源、lint 启发式边界 |

框架内核的成熟度明显高于“生产化”部分：编译期拦截、SSR 注水、回归测试密度是优势；
问题集中在服务端加固、文档与实现一致性、调度器性能、工程流程。

---

## P0 安全与正确性

### P0-1 SSR 缓存会跨用户串数据

- **现象**：缓存 key 只有完整 URL；`ttl` 默认 `0` 表示永不过期；淘汰是 FIFO，`map.get` 不续期。
- **证据**：[src/server/index.ts](../src/server/index.ts#L327-L368)
- **影响**：页面只要包含登录态、主题、个性化内容，A 用户的 HTML 就可能被回给 B 用户。
- **建议**：默认关闭缓存，或把 `Cookie` / `Vary` 纳入 key；文档明确“仅匿名页面可缓存”；
  长缓存场景改为 LRU / TTL 明确语义。

### P0-2 流式 SSR 渲染失败时状态码已经发出

- **现象**：`stream` 模式在等待渲染前就 `res.write(shell)` + `flushHeaders()`；之后渲染抛错，
  `catch` 里再设置 `500` 已无效，客户端实际收到 `200` + 半截壳 + 错误文本。
- **证据**：[src/server/index.ts](../src/server/index.ts#L359-L382)
- **影响**：错误页面被当成成功响应缓存、被 CDN 缓存或被监控漏掉。
- **建议**：流式前先完成“可能失败”的准备阶段，或失败时按可识别的客户端错误协议收尾；
  同时避免错误响应进入任何缓存层。

### P0-3 RPC 端点没有体积上限、鉴权与 CSRF

- **现象**：`req.on("data", (c) => (raw += c))` 无限累积；批量端点 `Promise.all` 无条数/并发上限；
  所有 `server()` 函数默认对外公开。
- **证据**：[src/server/index.ts](../src/server/index.ts#L77)
- **影响**：单个大请求即可打爆内存；批量接口可被用来放大请求；默认部署缺少鉴权指引。
- **建议**：增加 `maxBody`（默认 1MB，超限 413）与 batch 条数上限；文档给出鉴权 / CSRF /
  限流的中间件组合方式。

### P0-4 SSR 500 把内部错误原文回给浏览器

- **现象**：`res.end(\`[plain ssr] ${e.message}\`)` 会把文件路径、SQL、依赖栈片段带到响应体。
- **证据**：[src/server/index.ts](../src/server/index.ts#L380-L383)
- **影响**：生产环境信息泄露，也给攻击者提供探测线索。
- **建议**：生产只回通用错误文案 + requestId，详情写服务端日志。

### P0-5 hydrate 在真实浏览器替换只读 `window.document` 失败（已修复）

- **现象**：`hydrate()` 通过 `globalThis.document = makeClaimDocument(realDoc)` 安装认领式
  document。Chromium 的 `window.document` 是不可重新定义的只读访问器，真实浏览器抛
  `Cannot set property document ... which has only a getter`，hydration 直接不可用。
- **证据**：[src/runtime/hydrate.ts](../src/runtime/hydrate.ts)（`claim()` 的 document 安装段）
- **影响**：Node + DOM shim 下的测试与示例能跑，掩盖了真实浏览器不兼容；此前只能降级为
  “SSR 首屏 + 客户端重新挂载”，拿不到节点复用，也无法宣称 SSR 注水完成。
- **修复**：改为在真实 document 实例上临时覆盖创建方法（`installClaimDocument`），保存覆盖前
  的原始方法供 fallback 调用以避免递归，`finally` 中恢复；不替换全局属性、不扩充公开 API。
  新增“只读 document”回归测试。
- **状态**：已修复（2026-11-19）。

### P0-6 嵌套 `when()` 同名锚点配对错位导致内容丢失（已修复）

- **现象**：嵌套三元会编译出多对同名 `plain-?` / `plain-/?` 锚点。`claimPair()` 遇到第一个
  close 锚点就结束，把内层 close 当成外层结束，认领游标错位，后续节点认领失败、文本丢失。
- **证据**：[src/runtime/hydration-context.ts](../src/runtime/hydration-context.ts)（`claimPair`）
- **影响**：含嵌套三元/条件的页面 hydration 后内容缺失并产生 mismatch 告警。该问题在 P0-5
  修复、真正启用 hydration 后才暴露，此前被降级重挂载掩盖。
- **修复**：改为按同类锚点的嵌套深度计数，配对到最外层 close；新增嵌套三元回归测试。
- **状态**：已修复（2026-11-19）。

---

## P1 承诺与实现不一致

### P1-1 `effect` 回调返回清理函数：文档说支持，运行时忽略

- **现象**：`effect.run()` 直接 `return fn()`，没有任何清理登记；真正支持“回调返回清理”的是 `ref`。
- **证据**：[src/runtime/signal.ts](../src/runtime/signal.ts#L67-L74)、
  [src/runtime/ref.ts](../src/runtime/ref.ts#L71-L80)
- **文档冲突**：[docs/from-other-frameworks.md](from-other-frameworks.md#L27) 等 5 处
  写着可从 `effect` 回调 `return () => {}`。
- **影响**：AI 会照文档写，清理逻辑静默失效，造成监听器/定时器泄漏。
- **建议**：统一为一条路径 —— 要么实现 `effect` 返回清理，要么改文档并同步 AGENTS / patterns。

### P1-2 `__component` 以公开导出存在，却自称“内部符号”

- **现象**：`export { untracked as __component }` 在运行时主入口，注释写着“不在对外 API 面里”。
- **证据**：[src/runtime/index.ts](../src/runtime/index.ts#L49-L52)
- **影响**：与 AGENTS §7.1“运行时导出冻结、新增即 breaking”冲突；0.7.0 实际改变了 API 面。
- **建议**：挪到 `plain/internal` 子路径（与 `__ref` 同类处理），或明确修订“冻结”约定。

### P1-3 `resource()` 只认裸标识符，别名导入静默退化

- **现象**：编译器只匹配 `resource(...)`；`import { resource as r }` 拿不到 SSR 调用点 key，
  退化成“注水后再取一次”。
- **证据**：[src/compiler/index.ts](../src/compiler/index.ts#L299-L311)
- **影响**：结果正确但多一次请求，且没有任何提示；与已修复的 `server()` 别名/命名空间识别不一致。
- **建议**：复用同一套 import binding 解析；至少增加 lint 提示。

### P1-4 “没有 Proxy 魔法”与列表行实现矛盾

- **现象**：AGENTS §1 称“没有 Proxy 魔法”，但每个列表行都通过 `rowProxy`（真 Proxy）读取。
- **证据**：[src/runtime/dom.ts](../src/runtime/dom.ts#L458)、
  [src/runtime/signal.ts](../src/runtime/signal.ts#L289)
- **影响**：表述与实现不符，容易让读者误判运行时行为。
- **建议**：改为“没有用户侧深度响应式 Proxy；列表行代理是框架内部实现”。

### P1-5 0.7.0 没有 CHANGELOG，多处版本文档停留在 0.6

- **证据**：
  - [CHANGELOG.md](../CHANGELOG.md#L6-L8) 只有 `[Unreleased]` / `[0.6.0]`
  - [SECURITY.md](../SECURITY.md#L16) 写“当前 `0.6.x`”
  - [SPEC.md](../SPEC.md#L7) 写“当前 0.6.0”
  - [packages/create-plain/README.md](../packages/create-plain/README.md#L40) 仍写 `^0.6.0` /
    `plain-0.6.0.tgz`，而模板已是 `^0.7.0`
- **建议**：补 `[0.7.0]` 条目；版本号尽量从 `package.json` 注入，减少手写漂移。

### P1-6 README 测试数量过期

- **现象**：README 写“366（19 内核 + 347 单元）”；实测 `node --test "test/**/*.test.mjs"`
  为 **357 通过**，加上 19 个内核用例应为 376。
- **证据**：[README.md](../README.md#L659-L700)
- **建议**：数量改为脚本生成，或在 CI 中校验文档数字。

### P1-7 远端历史断点（已处理）

- **历史**：远程 main 曾被压成单个 root commit `017baa9`，0.6.0 及之前的提交不可达。
- **现状**：2026-11-17 已用非破坏方式恢复：按完整 SHA 拉回 `bb4d328`（0.6.0，104 个提交），
  以 `-s ours` 合并为 `ab2a105`。**代码树与删除 `.pnpm-store` 后的状态逐字节一致**，
  现有提交未被改写，远程为普通快进推送。
- **保留**：`restore/0.6.0` 分支指向 `bb4d328`，便于对比 0.6.0 与 0.7.0。

---

## P2 性能与架构

### P2-1 调度器热路径的固定开销

- **现象**：`flush()` 每一波都 `sort` + 新建两个 `Set` + `splice(0, length)`；`unqueue` 用
  `indexOf` / `splice`，最坏 O(n)。
- **证据**：[src/runtime/signal.ts](../src/runtime/signal.ts#L124-L190)
- **影响**：拖拽、输入、动画等高频写入场景有可测开销。
- **建议**：computed 与普通 effect 分两个队列替代排序；用数组游标替代 `splice`；
  先补基准再改。

### P2-2 `computed` 是 eager 的

- **现象**：创建即求值；模块级顺序敏感（`PLAIN_E1201` 本质是给这个设计兜底）；
  每次 `computed()` 分配 signal + effect 两个对象。
- **证据**：[src/runtime/signal.ts](../src/runtime/signal.ts#L243-L248)
- **建议**：评估惰性求值，但会牵动 flush 语义，需要基准与回归测试先行。

### P2-3 非 batch 写入也走完整调度

- **现象**：`signal.set` 每次都 `Array.from(subs)` + 入队 + 同步 flush。
- **证据**：[src/runtime/signal.ts](../src/runtime/signal.ts#L226-L238)
- **建议**：增加“单订阅者直跑”快路径，降低常见场景的分配。

### P2-4 静态服务无缓存头、无压缩

- **现象**：每次请求整文件 `readFile`，没有 `ETag` / `Last-Modified` / `Cache-Control` / 压缩。
- **证据**：[src/server/index.ts](../src/server/index.ts#L123-L170)
- **建议**：带 hash 的产物长缓存，HTML 短缓存；至少补 `ETag`。

### P2-5 覆盖率与 E2E 口径偏乐观

- **现象**：`.c8rc.json` 为 `all:false`，未被 import 的文件不计入分母；浏览器 E2E 只在
  `workflow_dispatch` 运行。
- **证据**：[.c8rc.json](../.c8rc.json)、[.github/workflows/ci.yml](../.github/workflows/ci.yml#L68-L96)
- **建议**：nightly 跑 E2E；定期用 `--all` 对照覆盖率真实水位。

### P2-6 缺少“AI 首次写对率”的趋势指标

- **现象**：CI 只跑 `eval/run.mjs --reference` 自检 harness，没有实际模型评测结果入库。
- **证据**：[.github/workflows/ci.yml](../.github/workflows/ci.yml#L51-L54)
- **影响**：框架的核心命题是“让 AI 首次写对”，却没有持续度量。
- **建议**：把评测结果按版本落库并出趋势；新增反模式时同步新增任务。

### P2-7 SSR 其他生产化缺口

- **现象**：`inflight` 无超时（挂起请求长期占内存）；`serve()` 无优雅关闭；`console.log` 直出。
- **证据**：[src/server/index.ts](../src/server/index.ts#L327-L380)
- **建议**：渲染超时、`SIGTERM` 优雅关闭、可注入 logger。

---

## P3 工程与维护

### P3-1 `.pnpm-store` 本地 162MB（不再入库）

- **现状**：已加入 [.gitignore](../.gitignore#L27)，当前工作树跟踪 0 个文件；
  但本地目录仍占约 162MB。
- **建议**：需要时手动清理 `rm -rf .pnpm-store`；CI 用 pnpm 自带缓存即可。

### P3-2 版本号分散硬编码

- **现象**：CHANGELOG / SECURITY / SPEC / README / create-plain 各自手写版本。
- **建议**：以 `package.json` 为唯一来源，发布脚本统一替换。

### P3-3 lint 启发式规则的已知边界

- **现象**：`E1202` / `E1203` 基于函数名与表达式形状判断，存在漏报/误报；目前靠抑制指令兜底。
- **证据**：[src/lint.ts](../src/lint.ts)
- **建议**：维护一份“已知误报/漏报清单”，比继续堆规则更可控。

---

## 建议处理顺序

1. 先修 **P0-1 ~ P0-4**（P0-5 / P0-6 已于 2026-11-19 修复）：成本低，直接关系安全与线上正确性。
2. 再统一 **P1-1 / P1-5 / P1-6 / P1-2 / P1-3**：文档与承诺一致性，直接影响 AI 写对率。
3. **P2-1 ~ P2-3** 先补基准再动，避免为了优化引入新的响应式语义分支。
4. **P2-6 / P2-5** 作为长期工程能力建设，与评测任务同步推进。
