# create-plain

Plain 官方脚手架，一键创建新的 Plain 项目。

## 用法

```bash
# 用 npx 直接跑（无需本地安装）
npx create-plain my-app

# 进入项目并启动
cd my-app
npm install
npm run dev
```

## 参数

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `[项目名]` | 目标目录名，也是 `package.json` 的 name | `my-plain-app` |
| `--template, -t` | 模板名（当前仅 `minimal`） | `minimal` |
| `--name, -n` | 等价于位置参数 | — |

## 做了什么 / 没做什么

- **做**：复制内置 `minimal` 模板到目标目录，并把模板里的 `__PROJECT_NAME__` 占位符替换成你的项目名。
- **不做**：不自动 `npm install`、不自动 `git init`、不联网。依赖安装和版本管理交给你。

## 模板内容

`minimal` 模板是一个最小可运行的 Plain 应用：

- `vite.config.ts`：使用 `plain/vite` 插件。
- `src/main.tsx`：一个 `signal` + `mount` 的最小示例。
- `tsconfig.json`：与框架一致的严格 TS 配置（`jsx: "preserve"` 必须保留）。

## 本地开发（框架尚未发布到 npm）

脚手架生成的 `package.json` 把 `plain` 写成 `"^0.3.0"`，默认假设框架已发布到 npm。
在**本地尚未发布**的情况下，直接 `npm install` / `pnpm install` 会找不到包。按下面三步即可指向本地源码：

1. 生成项目（任选一种，都不联网）：

   ```bash
   # 方式 A：直接跑脚本
   node /abs/path/plain-framework/packages/create-plain/index.mjs my-app

   # 方式 B：先注册成全局命令，之后任意目录随时用
   cd /abs/path/plain-framework/packages/create-plain && pnpm link --global
   create-plain my-app
   ```

2. 把 `my-app/package.json` 里的依赖改成指向本地框架目录（`link:` 会建立软链，框架改动 rebuild 后即生效）：

   ```json
   "plain": "link:/abs/path/plain-framework"
   ```

3. 安装并启动：

   ```bash
   cd my-app && pnpm install
   pnpm run dev
   ```

> 用 `link:` 后，`node_modules/plain` 是框架目录的软链，模板里的
> `import plain from "plain/vite"` 与 `import { signal } from "plain"` 都能正常解析，
> **无需改动 `vite.config.ts`**。
>
> 框架源码改动后，回到框架目录重跑 `pnpm run build` 即可（模板产物依赖 `dist/`；
> 框架仓库根的 `dist/` 通常已构建好，只有改了 `src/` 才需要重新 build）。
>
> 不想用软链、只想要一份固定副本时，可改用 `"plain": "file:/abs/path/plain-framework"`，
> 但 `file:` 默认是复制，框架改动后需重新 `pnpm install` 才能同步。
