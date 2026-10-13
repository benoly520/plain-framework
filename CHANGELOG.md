# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；提交信息遵循
[Conventional Commits](https://www.conventionalcommits.org/zh-hans/)。

## [Unreleased]

### 新增

- **列表 keyed 复用**：`arr.map(x => <li key={x.id}>…)` 现在按 key 认领行，
  头部插入 / 重排不会重建已有节点（关闭 `SPEC.md` §4 里 `each(..., keyFn, ...)` 的欠账）。
  `each()` 新增可选的第 4 个参数 `keyFn`；不传时行为与之前完全一致。
  安全规则：同一条 map 回调里**同时用到 index 参数时，key 会被忽略**（退回按位置复用），
  因为 keyed 复用下行只构建一次、捕获的 index 无法随位置更新。
- **结构化编译错误**：`PlainCompileError` 带
  `code`（`PLAIN_E1001`–`PLAIN_E1004`）/ `file` / `line` / `column` / `hint`，可 `JSON.stringify`，
  供 IDE / CI / AI 直接消费（`SPEC.md` §7「自解释错误」）。
- **编译产物 sourcemap**：`compile()` 返回 line 级 `map`，vite 插件会链式回传给 devtools，
  断点与堆栈可定位回 `.tsx` 源文件。
- 覆盖率度量与门禁：`pnpm run coverage`（c8 + `src` 级 sourcemap 映射），门槛写在 `.c8rc.json`。
- GitHub Actions 工作流（`.github/workflows/ci.yml`）：构建 + 内核/单元测试 + 覆盖率门禁；
  真实浏览器端到端改为手动触发。
- 单元测试套件 `test/*.test.mjs`（`node:test`）：覆盖 `lint` 规则与自动修复、`schema` 契约提取、
  `compiler` 报错兜底与 sourcemap、`cli` 子命令、`vite` 插件、`keyed` 列表语义、
  `server`（静态托管/目录穿越/RPC/起服）、SSR 序列化、运行时边界分支。
- `ROADMAP.md`（分阶段计划与验收标准）、`CONTRIBUTING.md`（环境、提交信息与改动要求）。

### 修复

- `lint`：JSX 属性里的 signal 漏调用会被重复报错，且两条 `fix` 区间重叠会让 `autofix`
  把源码改坏（`checked={done}` → `checked={done()()}`）。现在同一标识符只报一次，
  重叠的 fix 会被安全跳过。
- `compiler/manifest`：dev 增量更新时会把 `__plainHandlers` 当成用户函数再写一遍，
  产出重复 `const` 声明，导致多文件场景下 `/_plain/rpc` 直接加载失败。
- `test/browser.mjs`：不再硬编码 `/usr/bin/chromium`，改为环境变量
  （`PLAIN_CHROMIUM_PATH` / `CHROMIUM_PATH` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`）
  加常见路径探测，失败时给出可操作的提示。

### 变更

- 统一包管理器为 pnpm，移除 `package-lock.json`。
- `tsconfig`：打开 `noImplicitAny`，开启 `sourceMap` / `declarationMap`。
- `package.json`：新增 `engines`、`packageManager`、`sideEffects`。
- 从仓库移除构建产物 `plain-deliverable.zip`；`coverage/` 加入 `.gitignore`。

## [0.3.0]

TypeScript 源码 + tsc 构建；signals 响应式内核、编译到 DOM、`server()` 编译期物理剥离、
SSR 输出、路由与 ErrorBoundary、`plaindev` CLI 与 Vite 插件。
