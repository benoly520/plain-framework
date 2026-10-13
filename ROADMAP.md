# Plain 路线图

> 目标：从「可用 MVP+」走到「可被企业采用」。
> 每一项都给出**可验证的验收标准**；没写进本文件的，就不算计划内的承诺。

## 完成定义（DoD）

一个里程碑算完成，必须同时满足：

1. 有测试覆盖，且至少包含一条回归测试或边界测试；
2. `pnpm run coverage` 不低于 `.c8rc.json` 门槛，新增代码自身行覆盖不低于 85%；
3. README / CHANGELOG 同步，不出现「说做了但没做」的描述；
4. 对外 API 面若有变化，在 CHANGELOG 中显式标注为 breaking。

---

## M0 —— 质量基建 ✅ 已完成

- c8 覆盖率度量 + `.c8rc.json` 门槛（行 90 / 分支 82 / 函数 85）
- GitHub Actions：构建 + 内核/单元测试 + 覆盖率门禁
- 单元测试从 0 到 98 项，补齐原先零覆盖的 `lint` / `schema` / `compiler` / `cli` / `vite` / `server`
- 统一包管理器（pnpm）、`engines` / `packageManager` / `sideEffects`、`CHANGELOG` / `CONTRIBUTING`

## M1 —— 编译期与运行时正确性 ✅ 已完成

- **列表 keyed 复用**：`<li key={x.id}>` 时按 key 认领行，头部插入/重排不重建已有节点（关闭 SPEC §4 的欠账）
- **结构化编译错误**：`PLAIN_E100x` + `file` / `line` / `column` / `hint`，可 JSON 序列化（SPEC §7「自解释错误」）
- **产物 sourcemap**：line 级映射，经 vite 链式回传给 devtools

---

## M2 —— HMR（P0，未开始）

**现状**：`src/vite/index.ts` 只做 transform，改文件触发整页刷新（README「已知限制」）。
**为什么优先**：Plain 的核心场景是「AI 写 → 人看」，整页刷新会丢页面状态，迭代反馈环最痛。

**设计要点**

- 组件是纯函数 → 可以「重跑组件 + 替换它产出的 DOM 子树」，不必重载页面；
- 需要运行时侧一个挂载点注册表（记录组件挂在哪个容器/锚点）；
- 模块作用域的 `signal` 是难点：要么保留值，要么在控制台**明确告警**，不能静默重置。

**验收标准**

- [ ] 改一个只含 `signal` + 组件的文件，浏览器不整页刷新；滚动位置与 input 内容保留
- [ ] 模块作用域 `signal` 的值在热替换后保留（保留不了则必须显式告警）
- [ ] 组件被删除/替换后，旧组件的 effect 全部回收（复用 `createScope` 的泄漏断言方式）
- [ ] `test/hmr.test.mjs` 覆盖「替换 → 状态保留 → effect 回收」

**风险**：热替换下模块状态的语义很难两全，可能需要在 API 面上引入显式约定（如 `hot.state()`）——那属于新 API，需单独讨论。

---

## M3 —— SSR 注水 hydration（P0，未开始）

**现状**：`src/server/render.ts` 只输出 HTML，客户端会重新渲染一次（README 已明确标注）。

**验收标准**

- [ ] `hydrate(container, App)` 复用服务端已有节点，而不是清空重建（用节点身份断言）
- [ ] 文本/属性与服务端不一致时能就地修正，而不是整树重渲染
- [ ] 未注水的 `mount()` 行为完全不变（回归测试）
- [ ] `test/hydrate.test.mjs`：SSR 字符串 → 另一份 DOM 解析 → hydrate → 交互可用

**风险**：编译器目前无条件生成「建 DOM」指令；注水需要产物区分「首屏认领」与「后续更新」两条路径，改动面横跨 `compiler` + `dom.ts`。

---

## M4 —— AI 原生工具（P1）

- **MCP server**：把 `plaindev schema` / `plaindev check` / 编译错误暴露为 MCP 工具，AI IDE 可直接调用。
- **错误码统一**：`lint` 目前用 `plain/*`、编译器用 `PLAIN_E*`，两套并存，应收敛到一套。
- **契约 lint 扩展**：把 SPEC 的「铁律」（effect 外写入、`server()` 里引用不可序列化闭包）变成可自动修的规则。

**验收标准**

- [ ] MCP server 可被 AI IDE 连上，暴露 `schema` / `check` 两个工具
- [ ] 编译器与 lint 使用同一套错误码前缀

---

## M5 —— 生态与合规（需作者决策）

- **许可证（最高优先）**：当前 `LICENSE` 默认禁止商用，这与「企业级」目标互斥。
  需要二选一：真开源（MIT / Apache-2.0）换取采用，或给出明确可采购的商业授权条款（定价 / 支持 / SLA）。
  **在这个决策落地之前，本路线图不把「企业采用」列为可达目标。**
- 多入口 / 代码分割验证（当前只验证了单入口）
- RPC 请求合并 / 防抖
- 官方测试工具包（`render()` / `fireEvent` 之类），降低用户写测试的成本
- `SECURITY.md`

**验收标准**

- [ ] LICENSE 决策落地并同步 README
- [ ] 一个多入口示例通过 `plaindev build` 并在浏览器跑通

---

## 非目标（明确不做）

- 虚拟 DOM / 运行时整树 diff（与「编译到 DOM」的核心取舍冲突）
- 并发渲染 / 时间切片
- 为功能扩张而扩充对外 API 面（SPEC 原则 6「稳定小核心」）
- 刷 100% 行覆盖率（用变异测试衡量断言强度，而不是堆执行过的行）
