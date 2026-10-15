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

- `vite.config.ts`：使用 `plain/vite` 插件（需先 `npm i plain` 安装框架）。
- `src/main.tsx`：一个 `signal` + `mount` 的最小示例。
- `tsconfig.json`：与框架一致的严格 TS 配置。

> 在框架仓库内部开发时，如果想让模板指向本地构建的 `dist/`，可把模板
> `vite.config.ts` 里的 `plain/vite` 改回相对路径别名（参考 `examples/*/vite.config.js`）。
