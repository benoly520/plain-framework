# 面向 AI 时代的前端框架：问题诊断与从 0 设计草案

> 讨论缘起：用户认为 Vue / React / Angular / Solid / Svelte 等主流框架"过度设计"、不符合 AI 时代的 vibe coding 范式。
> 本文先校准前提，再基于各框架 2026 年最新版本做诊断，最后给出一个"从 0 设计"的候选方案。

---

## 一、前提校准：直觉对了一半

"过度设计"须拆成两层：**给人类减负的设计** vs **给 AI 生成代码服务的设计**。两者的优化方向经常相反。

一个反直觉的事实：2024–2026 的主流框架最新版本，正在收敛到同一条技术路线——**signals（细粒度响应式）+ 编译到真实 DOM（去掉虚拟 DOM diff）**：

- **React 19.2.x**：React Compiler 1.0 稳定（2025-10），自动 memo，useMemo/useCallback 基本不再必要；Server Components 稳定。
- **Vue 3.5.x / 3.6 Vapor（RC）**：响应式系统重写（内存 -56%、大数组 10×），Vapor Mode 编译器直接出 DOM 操作，对标 Solid 性能。
- **Angular v22（2026-06）**：signals-first、zoneless 默认、standalone 取代 NgModule、Signal Forms 稳定、内置 MCP Server 支持。
- **Svelte 5.56.x（Runes）**：`$state/$derived/$effect` 显式响应式，编译到 DOM，无框架运行时。
- **Solid 1.9.x / 2.0 RC**：细粒度 signals，JSX 编译为直接 DOM 操作，SolidStart 2.0 稳定。

**结论**：技术方向上"细粒度 + 编译期消除运行时"已是共识；但收敛不彻底，且每个框架都背着历史包袱——而这些包袱恰恰是 AI 生成代码的雷区。

---

## 二、最新版本与各自的"AI 摩擦点"

| 框架 | 当前稳定版 | AI 最易踩的坑 |
|---|---|---|
| React | 19.2.x（Compiler 1.0 已稳） | Hooks 调用顺序、deps 数组缺漏、ref 清理、RSC 服务端/客户端边界模糊、20+ hooks 选择困难 |
| Vue | 3.5.x（3.6 Vapor 进 RC） | `.value` vs 裸值、Proxy 响应式魔法、模板与 `<script>` 分离、Options/Composition 双范式 |
| Angular | v22（signals-first） | 装饰器 + DI + NgModule 遗留、RxJS、模板强分离、规则最多 |
| Svelte | 5.56.x（Runes） | 模板与逻辑分离、`.svelte.ts` 共享状态陷阱、snippets 新语法 |
| Solid | 1.9.x（2.0 RC） | `createSignal` 的 `[get, set]` 心智、2.0 破坏性改动 |

---

## 三、为什么现有框架对 AI 不友好（核心分析）

不是"复杂"本身的问题，而是复杂落在了 AI 最难处理的几个维度上：

1. **隐式规则（最致命）**：AI 生成代码是"看一眼上下文就续写下一段"。React Hooks 的调用顺序、deps 数组、Vue 的 Proxy 自动追踪——这些规则**不在代码本地可见**，AI 容易生成"能跑但偶发 bug"的代码。Svelte 5 / Solid 把响应式改成显式 runes/signals 后此项大幅改善，这也是它们评分最高的原因。

2. **API 面太大、等价写法太多**：React 20+ hooks、Vue 的 Composition/Options、Angular 的 DI+RxJS+Forms。AI 面临"选哪个"的组合爆炸，且不同选择互相影响。选择越少，生成越稳。

3. **模板与逻辑分离**：Vue/Svelte/Angular 把 markup 和 script 拆开，AI 必须同时维护两份表示并保持一致。JSX（React/Solid）反而更友好——单文件单语言。

4. **服务端/客户端边界靠"猜"**：RSC、Svelte 的 `load`/`remote`、SolidStart、Angular SSR——代码到底在哪端跑，常要 AI 推断。这是生产事故高发区。

5. **范式漂移**：每个框架近一两年都改了根本范式（Compiler / Vapor / Signals / Runes）。AI 训练数据里旧范式占多数，生成的"新知识"代码常是错的。

> **综合判断**：Svelte 5 与 Solid 已最接近 AI 友好——显式响应式 + 编译到 DOM + 小运行时。尚未解决的是：**模板/逻辑分离、服务端边界模糊、API 面仍偏宽**。一个"从 0"的框架应拿走它们的优点，补掉这三点。

---

## 四、面向 AI 的框架设计草案（候选）

**一句话核心**：让"读代码就能推出行为"成为唯一规则，其他一律编译掉。

### 设计原则（按对 AI 的重要性排序）

| # | 原则 | 具体做法 |
|---|---|---|
| 1 | **Locality（本地可推）** | 无 hook 顺序、无 deps 数组、无 Proxy 魔法；effect 自动追踪读取了什么 |
| 2 | **唯一状态原语** | 只有 `signal` / `computed` / `effect`，没有 useState/useReducer/context 等 20 种变体 |
| 3 | **单文件单语言** | markup + 逻辑同一作用域（学 JSX 优点），不做模板/逻辑分离 |
| 4 | **显式执行边界** | 用 `server` / `client` 一个关键字声明代码在哪端跑，杜绝猜测 |
| 5 | **编译到 DOM** | 零框架运行时，组件编译成直接 DOM 操作（学 Svelte），bundle 小、AI 不用懂运行时 |
| 6 | **稳定小核心** | 约定俗成的约 10 个原语，API 长期冻结，AI 知识不过期 |
| 7 | **类型即校验** | 非法组合在编译期不可表达，错误信息自带修复片段 |
| 8 | **AI 原生工具** | 机器可读的组件 schema，AI 不用通读源码即可 introspect；lint 直接给改法 |

### 示意草图（刻意写得"无聊"）

```plain
// counter.plain
component Counter {
  let count   = signal(0)              // 唯一状态原语，读写为普通变量
  let doubled = computed(() => count * 2)

  view {
    <button onclick={count = count + 1}>
      clicked {count} (doubled: {doubled})
    </button>
  }
}

// 服务端/客户端边界用关键字显式声明，AI 不猜
server function loadUser(id) {
  return db.users.find(id)             // 编译期锁定在服务端
}
component Profile(id) {
  let user = await loadUser(id)
  view { <h1>{user.name}</h1> }
}
```

### 关键取舍：裸变量信号（`count = count + 1`）

本质是 Svelte 5 / Vue Vapor 的编译器魔法——`=` 赋值被编译成信号写入。对 AI 极友好（写的就是普通 JS），代价是"魔法"。**判断：值得**。因为魔法被限制在赋值语法一个点上，且编译器能直接报错 misuse；相比之下 React 的 deps 数组是散落各处的、编译器救不了的隐性陷阱。

---

## 五、两个关键取舍与风险

- **"从 0 造" vs "减法"**：路由、状态库、组件生态、部署适配才是成本大头。建议**取 Solid/Svelte 的响应式+编译内核，套一层"减法外壳"**——砍掉模板/逻辑分离、钉死 server/client 边界、冻结小 API 面。真从 0 写编译器，90% 精力会浪费在别人已做的事上。

- **与 "Svelte + Vapor" 的区别**：就在上面三点没解决的——Svelte 仍是模板/逻辑双文件、server 边界靠约定、runes 之外还有 snippets 等衍生概念。新框架的价值是**把这些也收敛掉**，把"AI 需要记住的规矩"压到接近零。

---

## 六、结论

> 现有框架不是"过度设计"，而是在**为人类的认知减负**（hooks、DI、响应式语法糖），但这套减负机制恰好是 AI 的增负机制。AI 时代的前端框架，目标应从"让人类少写"转向**"让生成结果可预测、可校验、无歧义"**。技术上无需新发明——signals + 编译到 DOM 已是共识；真正的工程创新在**极致的减法、显式的边界、冻结的小核心，以及 AI 原生工具链**。

---

## 下一步可选

1. 把候选设计写成一份**最小可行规范**（组件模型、编译目标、边界语义）。
2. 直接**用 Solid/Svelte 内核做一次减法原型**（一个能跑的 demo 框架）。
