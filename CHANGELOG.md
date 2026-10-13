# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；提交信息遵循
[Conventional Commits](https://www.conventionalcommits.org/zh-hans/)。

## [Unreleased]

### 新增

- 覆盖率度量与门禁：`pnpm run coverage`（c8 + `src` 级 sourcemap 映射），
  门槛写在 `.c8rc.json`。
- GitHub Actions 工作流（`.github/workflows/ci.yml`）：构建 + 内核/单元测试 + 覆盖率门禁；
  真实浏览器端到端改为手动触发。
- 单元测试套件 `test/*.test.mjs`（`node:test`）：覆盖 `lint` 规则与自动修复、`schema` 契约提取、
  `compiler` 报错兜底、`cli` 子命令、`vite` 插件、`server`（静态托管/目录穿越/RPC/起服）、
  SSR 序列化、运行时边界分支。
- `CONTRIBUTING.md`：环境、提交信息与改动要求。

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
