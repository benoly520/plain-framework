# RFC：顶层 `computed` / `effect` 回调的前向引用检查 —— `PLAIN_E1201`（已实现）

> **状态**：方案 3.1 已实现（`PLAIN_E1201` / `no-eager-computed-forward-ref`，见 §4 落地清单）。
> **编号说明**：RFC 初稿曾预设 `PLAIN_E1116`，实现时依 `src/errors.ts` 的编号约定
> 落在 `E12xx`（lint：需手工修，不自动改）段，取段内首号 `PLAIN_E1201`。
> **缘起**：website-mirror-downloader 项目（Plain 的真实使用方）在开发中踩坑：
> 模块顶层的 `computed` 回调引用了**文本位置在其后**声明的 `const`，import 时即抛
> `ReferenceError: Cannot access 'unmirroredSelCount' before initialization`。
> 这类错误 tsc 查不到（见 §2.2），只能在浏览器控制台里炸——而框架**知道**通用工具
> 不知道的关键事实：`computed` / `effect` 的回调在创建那一刻就会同步执行。
> 本 RFC 提议把这一事实变成一条构建期 lint 规则。
> **相关**：`AGENTS.md` §3 反模式目录 / §4 错误码、`src/lint.ts`、`src/errors.ts`、
> `src/runtime/signal.ts`、`docs/internals.md` §4.2、`test/lint.test.mjs`

---

## 1. 问题

### 1.1 真实案例（website-mirror-downloader / frontend/src/main.tsx）

```ts
// 先定义（引用了后面才声明的两个 computed）
const selButtonLabel = computed(() => {
  const m = lastSelMode();
  if (m === 'all') return `全选 (${unmirroredSelCount()}, 不含已下载)`;
  if (m === 'all-inc') return `全选 (${allSelCount()}, 包含已下载)`;
  return `全选本页 (${works().length})`;
});

// ……十余行之后才定义被引用者
const allSelCount = computed(() => (showRemoved() ? 0 : total()));
const unmirroredSelCount = computed(() => { /* … */ });
```

浏览器报错：

```
main.tsx:644 Uncaught ReferenceError: Cannot access 'unmirroredSelCount' before initialization
    at main.tsx:644:1
    at signal.ts:191:24
    at Object.run (signal.ts:65:16)
    at effect (signal.ts:96:5)
    at computed (signal.ts:191:3)
    at main.tsx:642:1
```

报错发生在**模块求值阶段**（import 时），页面白屏，且报错栈指向的是使用方代码的
行号而非「声明顺序错了」这个本质——对 AI 和人都不够自解释。修复只能是调整声明顺序
（把 `selButtonLabel` 挪到两个计数之后），修复方式本身就是规则提示语的最佳素材。

### 1.2 最小复现

```ts
import { signal, computed } from "plain";

const a = computed(() => b());   // 创建即求值 → 读 b 撞 TDZ → import 时抛错
const b = signal(0);
```

`effect` 同理（`effect(fn)` 创建时也立即 `run()`），且更常见：顶层 `effect` 回调里
读后置 `const` 是同一类错误。

## 2. 根因

### 2.1 `computed` 创建即求值

`src/runtime/signal.ts:188-193`：

```ts
export function computed<T>(fn: () => T, owner?: Owner): Signal<T> {
  const out = signal<T>(undefined as unknown as T);
  effect(() => out.set(fn()), owner);
  return out;
}
```

而 `effect()` 末尾无条件 `e.run()`（`src/runtime/signal.ts:96`）。所以**任何位置**
的 `computed(...)` / `effect(...)` 调用都会在**调用的那一刻**同步执行回调一遍。
放在模块顶层，执行时机就是 import 阶段——此时同模块后置的 `const` / `let` / `class`
尚处于暂时性死区（TDZ）。

这与 `docs/internals.md` §4.2「computed 不是惰性图」的设计取舍一致：
无惰性求值、无拓扑排序，换来 20 行实现与可本地推理。**代价之一此前没有写明：
顶层声明顺序成为硬约束，且错误暴露时机是 import 而非首次渲染。**

### 2.2 为什么 tsc / 常规工具链查不到

tsc 的 TS2448（Block-scoped variable used before its declaration）只覆盖**直接使用**：

```ts
const a = b;      // TS2448 ✅ 能查出
const b = 1;

const f = () => b; // 不报——函数体的执行时机 TS 认为不可知，视为合法
const b = 1;
```

`computed(fn)` 的引用都藏在回调函数体里，TS 无法知道「这个回调会在创建时立即执行」
——这是框架的**领域知识**，通用类型检查器天然缺失。ESLint 的 `no-use-before-define`
默认配置同样不覆盖此形态（且不区分「创建即执行」的调用约定）。

### 2.3 这条规则的独特价值

plain 的 lint 体系（`src/lint.ts`）已经建立了一个先例：`PLAIN_E1111`
（computed 里写 signal，`src/lint.ts:422-433`）同样是「利用框架对回调执行时机的
承诺做静态检查」。`PLAIN_E1201` 是同一思路的延伸：**框架承诺的执行时机，就是
框架专属静态分析的抓手**——这是 tsc / ESLint 永远不会替我们做的事。

## 3. 方案

### 3.1 主方案：新增 lint 规则（error 级，构建闸门）—— 已实现为 `PLAIN_E1201`

**规则名**：`no-eager-computed-forward-ref`（沿用 `errors.ts` 的 kebab-case 命名，
如 `no-computed-side-effect` / `no-module-scope-resource`）。

**作用域**：只检查**模块顶层**的 `computed(cb)` / `effect(cb)` 调用
（含经 `import` 的原始名与本地别名）。理由：eager 语义只在这一层致命——
组件函数体内的 `computed` 在 render 时才执行，彼时模块早已求值完毕。

**检测算法**（v1）：

1. 遍历顶层语句，登记两类信息：
   - eager 调用：声明名（如有）+ 源码位置 + 回调节点；
   - 模块级块级作用域声明（`const` / `let` / `class`）的名字与位置
     （`function` 声明会提升、`var` 无 TDZ，均排除）；
2. 对每个 eager 回调，收集**回调函数体内、非嵌套函数内**的标识符引用；
3. 引用命中「位置在其后」的模块级声明 → 报 error：

   > `PLAIN_E1201`：顶层 `computed` 创建即求值，但引用了后面才声明的
   > "unmirroredSelCount"。把该声明挪到这个 `computed` 之前
   > （TDZ：import 时就会抛 ReferenceError）。

**口径取舍**：嵌套函数体内的引用 v1 **不报**（欠报而非误报）。eager 回调里再包
thunk、thunk 里读后置常量的写法在模块顶层极罕见，而误报对构建闸门的伤害远大于
漏报；欠报的部分交给 §3.3 的运行时兜底与未来的二期分析。只报**直连引用**即可
覆盖本次案例与绝大多数实际踩坑形态。

**不可自动修**：重排声明顺序没有安全的自动改写（可能跨数百行、牵动注释与作用域），
与 `PLAIN_E1112`（props 漏 resolve）一样 `fix === undefined`，测试钉死。
规则可被 `plain-ignore` 抑制（见 `AGENTS.md` §4.1，lint 规则均suppressible）。

**v1 不覆盖**（如实写进规则提示文档）：间接引用链（前面定义的辅助函数内部读后面的
const）；跨模块 import 环 + eager `computed`（需要模块图分析，作二期）。

### 3.2 备选方案：`computed` 惰性化（单独立项，不在本 RFC 实施）

把 `computed` 改成首次读取时才求值（Solid 语义），可**整类消灭**这个问题：
首读发生在 mount 渲染期，模块早已初始化完，TDZ 不复存在。

代价与顾虑：

- **语义变更**：依赖首次建立的时机从「创建时」推到「首读时」；
  `src/runtime/router.ts:73-76` 有一条「刻意不用 computed（会缓存跨请求匹配结果）」
  的注释，说明框架对求值时机有明确立场，惰性化会放大而非缩小这类耦合；
- 回归面：SSR / hydration / HMR 全链路 + `test/` 全量；
- 报错时机同样后移（从 import 推到首渲染），自解释性并不更好。

结论：值得作为独立 RFC 评估，但**不作为本问题的前置依赖**。

### 3.3 两个方案的关系

`PLAIN_E1201` 先落地：把已知形态拦在构建期，零运行时风险；
惰性化若未来立项，规则自然退化为 no-op（查不出问题但也不误报），无需回收。
两者不是二选一，是「先闸门、后根治」的顺序关系。

## 4. 落地清单

| 项 | 文件 | 说明 | 状态 |
| --- | --- | --- | --- |
| 错误码 | `src/errors.ts` | `PLAIN_E1201`（规则名 `no-eager-computed-forward-ref`，suppressible: true；编号依约定落在 E12xx 段首） | ✅ |
| 规则实现 | `src/lint.ts` | `checkEagerForwardRef`：算法见 §3.1；error 级，vite 插件默认让构建失败 | ✅ |
| 测试 | `test/lint.test.mjs` | 十项：真实案例（应报）/ effect / class / 组件体内合法引用（不报）/ 先声明（不报）/ var（不报）/ 局部遮蔽（不报）/ 嵌套 thunk（不报，欠报口径钉死）/ 类型与属性名（不报）/ `plain-ignore` 抑制 | ✅ |
| 文档 | `AGENTS.md` §3 / §4 | 反模式目录 #23；错误码表加一行；§4 编号说明补 E12xx 段 | ✅ |
| 文档 | `README.md` / `README_CN.md` / `CHANGELOG.md` | 契约规则表与 Unreleased 新增条目 | ✅ |
| 文档 | `docs/internals.md` §4.2 | 补一句非惰性语义的 TDZ 副作用，链回本 RFC | ⬜ |

## 5. 规则提示语文案（草案）

```
PLAIN_E1201: 顶层 computed/effect 创建即求值，但引用了后面才声明的 "<name>"。
把 "<name>" 的声明挪到这个调用之前（const 有暂时性死区，import 时就会抛
ReferenceError）。若引用确实需要延迟，可改为在读值时求值的形式。
```
