# 数据表格示例（data-table）

展示 Plain 在**大规模数据**下的表现：5 万行数据、列排序、关键字搜索，全部基于 signals 的细粒度更新。

## 这个示例在证明什么

企业后台最常见的"数据表格"场景，传统框架容易踩两个坑：

1. **渲染整张表**：5 万行 → 5 万个 DOM 节点，滚动卡顿。
2. **排序/筛选重建整表**：哪怕只变了一行，也要 diff 一大片。

Plain 的做法：

- 原始数据只生成一次，存进 `signal<Row[]>`（参考 [`main.tsx`](main.tsx) 的 `allRows`）。
- 搜索 + 排序是 `computed`，**只在依赖变化时重算**，不是每次渲染都跑。
- 视口内只渲染"看得见"的约 20 行，上下各用一个占位 `div` 撑出真实滚动高度（窗口化 / 虚拟列表）。
- 滚动时只更新占位高度与少量可见行，**DOM 节点数恒定**，不会随数据量膨胀。

## 运行

```bash
# 根目录先编译框架
pnpm install && pnpm run build

# 启动本示例（端口 8101）
pnpm run dev:example:data-table
```

构建产物：`pnpm run build:example:data-table`。

## 关键代码

| 关注点 | 位置 |
| --- | --- |
| 生成假数据 | `generateRows()` |
| 搜索 + 排序视图 | `view` (computed) |
| 窗口计算 | `start` / `end` / `windowRows` (computed) |
| 滚动更新 | `viewport` 的 `onScroll` → `scrollTop` signal |
| 表头排序 | `setSort()` |
