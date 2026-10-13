# 贡献指南

## 环境

- Node.js >= 20.11
- pnpm（版本以 `package.json` 的 `packageManager` 为准）

```bash
pnpm install
pnpm test          # 构建 + 内核 19 项 + 单元 82 项
pnpm run coverage  # 覆盖率（低于 .c8rc.json 门槛会失败）
pnpm run test:browser   # 可选：需要本机有 Chromium/Chrome
```

### 更新锁文件必须用官方 registry

CI 用官方 registry `https://registry.npmjs.org/`，并会跑 pnpm 的供应链校验：
锁文件里记录的 tarball URL 必须与 registry 发布元数据一致。

如果本地配了淘宝镜像（`registry.npmmirror.com`，或旧域名 `registry.npm.taobao.org`），
pnpm 会把镜像的**绝对 tarball URL**写进 `pnpm-lock.yaml`。这样的锁文件一到 CI 就会被判失败：

```
[ERR_PNPM_TARBALL_URL_MISMATCH] 168 lockfile entries failed verification:
  @acemir/cssom@0.9.32 has a tarball URL (https://registry.npmmirror.com/...) that
  does not match the registry's published metadata (https://registry.npmjs.org/...)
```

所以**每次更新锁文件都要显式指定官方 registry**：

```bash
# 只重新解析锁文件（推荐，快）
pnpm install --lockfile-only --registry=https://registry.npmjs.org/

# 或者做一次完整安装
pnpm install --registry=https://registry.npmjs.org/
```

提交前自查一下，锁文件里不应残留镜像 URL（下面应输出 `0`）：

```bash
grep -c 'tarball: https://registry.npm' pnpm-lock.yaml
```

## 提交信息约定

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<type>(<scope>): <描述>
```

- 常用 type：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`
- `scope` 用模块名，例如 `lint` / `compiler` / `runtime` / `server` / `vite` / `cli`

示例：

```
fix(lint): 属性场景漏调用 signal 被重复报错
feat(compiler): 支持嵌套 Fragment
```

## 改动要求

1. **行为变更必须带测试**。`pnpm run coverage` 不得低于 `.c8rc.json` 中的门槛；
   修 bug 时请补一条能复现原问题的回归测试。
2. **维持「稳定小核心」**：对外 API 面新增即 breaking change，请先开 issue 讨论，
   不要在 PR 里直接扩充导出。
3. **安全红线**：编译产物与运行时不得出现 `innerHTML` / `eval`；
   `test/run.mjs` 对此有断言，新增代码请保持通过。
4. **跨端边界**：`server()` 的函数体会被物理搬到服务端，不要把闭包里的外部变量当作可用。
5. 提交前请本地跑一遍 `pnpm test`；涉及浏览器行为时再跑 `pnpm run test:browser`。
