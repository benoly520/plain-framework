# 单文件样式：可选形态（未实现）

> **状态：设计记录，未实现。收益比低、优先级低，不在路线图上。**
>
> 两种候选形态（文件末尾注释块、同级样式组件）**都没有落地**：相关实现、`styleBlock` 开关、
> `PLAIN_E1012`、测试与 `examples/sfc/` 已随结论一起回滚。本文留档设计细节与实测，
> 供将来需要时按 §6 重启，或作为"为什么最终没做"的决策依据。

## 1. 想解决的问题

组件和它的 CSS 分在两个文件里，改动时要在 `Card.tsx` 与 `Card.css` 之间来回跳，删组件容易留下孤儿样式。
"样式与视图同文件"是这个需求的本体，**语法形式只是手段**。

## 2. 五种候选形态

| 形态 | 合法 TSX | 关闭开关时 | 编辑器 | 样板量 | 归属方式 |
| --- | --- | --- | --- | --- | --- |
| 2.1 文件末尾注释块（曾实现，已回滚） | ✅（是注释） | 样式不生效，构建告警 | 注释文本，无 CSS 高亮 | 最少 | 文件 |
| 2.2 **同级样式组件**（本文重点） | ✅（是真 JSX） | 样式不生效（无人渲染） | 正常 JSX，可折叠；CSS 仍无高亮 | 多一个导出 | 命名配对 |
| 2.3 组件内 `<style>{…}</style>` | ✅ | 运行时注入，样式仍生效 | 正常 JSX；CSS 仍无高亮 | 少 | 组件 |
| 2.4 ``css`…` `` 标签模板语句 | ✅ | 调用 noop，样式不生效 | 装扩展可高亮 | 最少 | 位置（紧邻的下一个函数） |
| 2.5 独立 `.css` | — | 生效 | 完整 CSS 语言服务 | 两个文件 | 文件名 |

被否掉的原因：

- 2.3 把样式放进渲染树，`<style>` 成了视图的一部分，语义上不对；
- 2.4 形态上是注解式的，但 `css` 标签里**仍是字符串** —— "像注解、不进视图、又有高亮"三者
  在无编辑器扩展时不可兼得（见 §4）；
- 真正的 `@Style(...)` 注解写法不可行：TS 装饰器只能贴在 class 及其成员上，函数声明报
  `TS1206: Decorators are not valid here`（已实测）。

结论：**编辑体验的瓶颈不在语法，而在"没有 CSS 语言服务"**。任何语法方案都要额外交付编辑器侧，
所以"单文件样式"整体收益比偏低、优先级也低 —— 这是本节存在的意义。

## 3. 可选形态：同级样式组件

### 3.1 写法

组件与它的样式组件并排导出；样式组件只做声明，不被渲染：

```tsx
export function Counter(props: { label: string; start: number }) {
  const count = signal(resolve(props.start));
  return (
    <div class="counter">
      <button class="counter-btn" onClick={() => count.set(count() - 1)}>−</button>
      <span class="counter-value">{count()}</span>
      <button class="counter-btn" onClick={() => count.set(count() + 1)}>+</button>
      <span class="counter-label">{resolve(props.label)}</span>
    </div>
  );
}

export function CounterStyle() {
  return (
    <style>{`
      .counter { padding: 12px; border-radius: 8px }
      .counter-value { font-weight: 700 }
    `}</style>
  );
}
```

命名约定：`Xxx` ↔ `XxxStyle`。约定只用于阅读与 lint 弱检查，拆分层**不依赖名字**（见 3.2）。

### 3.2 拆分层识别规则（TS AST，不看位置、不看注释）

对每个源文件：

1. 只看**顶层** `FunctionDeclaration`（函数体必须是块，且只有一条 `return`）；
2. `return` 的表达式（允许被括号包裹）必须是 `JsxElement`，tag 名为 `style`；
3. 该元素的子节点去掉纯空白后**有且只有一个** `JsxExpression`，表达式是
   `NoSubstitutionTemplateLiteral` 或 `StringLiteral`；
4. 命中 → 取字面量文本作为 CSS，把**整个函数声明**用等长空白替换（逐字符换成空格、保留换行）；
5. 一个文件多块按源码顺序合并成一份 CSS，写进虚拟 CSS 模块。

第 4 步的"等长空白"是关键：不重排行号、不破坏 sourcemap，报错定位仍然指回原文件。
这几步已经在 2026-10 做过 PoC（见 §5），实现本身没有技术风险。

### 3.3 四条硬约束

违反任一条都**报错**（建议复用 `PLAIN_E1012`），不静默降级：

1. **关闭 `styleBlock` 时不许出现样式组件。** 它是纯声明，没人调用 → 样式不会生效。
   与注释块"告警"不同，这里建议直接报错并提示开启开关：写了 `XxxStyle` 就说明要用这个能力，
   让语法本身成为"要开启"的信号，比事后发现样式消失更好。
2. **样式组件不可被引用。** 同文件写 `<CounterStyle />`（或把它塞进任何 JSX / 表达式）会在
   剔除后变成未定义标识符；跨文件 `import { CounterStyle }` 会让构建报 missing export。
   同文件引用要在拆分层里检测并报错；跨文件引用交给构建期兜底。
3. **内容必须是无插值的字符串。** 带 `${…}` 无法在构建期求值 → 报错，提示改用独立 `.css`
   或运行时 `style={{ … }}`。
4. **一个函数只返回一个 `<style>`，不带其它节点与属性。** `scoped` / `lang` 不支持（同注释块）。

### 3.4 与注释块形态的关系

| | 注释块（曾实现，已回滚） | 同级样式组件（可选） |
| --- | --- | --- |
| 定位方式 | 词法扫描注释 | TS AST 形态 |
| 归属 | 文件末尾 | 命名配对 + 同文件 |
| 一个文件多块 | 不支持 | 支持 |
| 关闭开关时 | 告警 | 报错（见 3.3-1） |
| 抽取 / HMR | 虚拟 CSS 模块 | **完全相同** |

共用部分：`STYLE_IMPORT_PREFIX` / 虚拟模块 id、vite `load` / `resolveId` / `handleHotUpdate`、
构建期 CSS 抽取与 dev 期 CSS HMR。差异只在"如何找到 CSS 文本"。

落地时建议**二选一**：同一项目里不要同时用两种形态，冲突时直接报错，省掉"优先级"这种解释。

## 4. 编辑器体验（必须诚实说明）

`<style>{…}</style>` 是合法 JSX：可折叠、可跳转、`tsc` 不红；但 CSS 文本仍是字符串 ——
**没有 CSS 语言服务，就没有高亮、补全、诊断。**

Vue 单文件组件的体验来自 Volar（插件），不是 `.vue` 语法本身。同理，本方案要补体验只有两条路：

1. **grammar 注入**：把 `<style>{…}</style>` 区域按 `source.css` 上色 + 可折叠，几十行配置，成本低；
2. **接 `vscode-css-languageservice`**：字符串内部的补全、未知属性告警、悬停，成本明显更高。

这也是"收益比低、优先级低"判断的核心：语法可以随便换，**编辑器侧的成本省不掉**。

## 5. PoC 实测记录（2026-10）

一次临时的同级样式组件实验（`Counter` + `CounterStyle`）：

| 项目 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过 |
| `plaindev check` | 通过（4 个文件，无误报） |
| AST 识别 | 命中 `CounterStyle`，同文件引用数 0 |
| 等长空白剔除 | 函数原来的第 10–18 行变为空白，其余行号不变 |
| 剔除后重新编译 | 产物中 `createEl("style")` 数量为 0 |

另外两项对照实验：

- 函数声明上贴 `@Dec` → `error TS1206: Decorators are not valid here`（注解路线不可行）；
- ``css`…` `` 前缀语句 → `tsc` 通过、`plaindev check` 通过、编译器原样保留该语句（关闭开关时是 noop 调用）。

## 6. 如果将来要做：落地清单

1. 新建 `src/sfc.ts`：AST 识别 + 等长空白剔除 + 引用检测 + 插值检测；
2. `src/vite/index.ts`：加 `styleBlock` 开关与虚拟 CSS 模块（`load` / `resolveId` / `handleHotUpdate`），
   关闭时检测到样式组件 → 报错（不是告警）；
3. 测试：识别、多块、同文件引用报错、插值报错、行号保持、关闭开关报错、与注释块混用报错；
4. 新建 `examples/sfc`（`Counter` + `CounterStyle` 配对写法）；
5. 文档：README_CN / README / AGENTS / SPEC / patterns 同步，并更新本文的状态行。

## 7. 当前建议

**不实现（收益比低、优先级低）。** 需要单文件样式时用独立 `.css` / `.module.css`（现成语言服务、
零构建改造）；确实要"同文件"时按 §6 重启，先做注释块形态、再评估样式组件。
本文留档，避免以后重复讨论同一组取舍。
