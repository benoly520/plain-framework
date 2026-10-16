// Plain 示例：企业级数据表格
//
// 覆盖：大规模数据下的窗口化渲染（虚拟列表）/ 列排序 / 关键字搜索
//      —— 全部基于 signals 的细粒度更新，排序与滚动不会重建整张表
//
// 要点：
//   · 5 万行数据只生成一次（signal 存原始数组）
//   · 搜索 + 排序是 computed，只在依赖变化时重算
//   · 视口内只渲染「看得到」的 ~20 行，上下用占位 div 撑出真实滚动高度
//   · 滚动时只更新占位高度与少量可见行，DOM 节点数恒定

import { signal, computed, mount, resolve } from "plain";

type Row = {
  id: number;
  name: string;
  email: string;
  dept: string;
  score: number;
  status: "active" | "idle" | "blocked";
  joined: string;
};

const COLUMNS = [
  { key: "id", label: "ID" },
  { key: "name", label: "姓名" },
  { key: "email", label: "邮箱" },
  { key: "dept", label: "部门" },
  { key: "score", label: "评分" },
  { key: "status", label: "状态" },
  { key: "joined", label: "加入日期" },
] as const;

const DEPTS = ["平台", "增长", "交易", "风控", "数据", "基础架构"];
const STATUSES: Row["status"][] = ["active", "idle", "blocked"];

// 演示用：确定性生成一批假数据（真实项目里通常来自 server() 的 RPC）
function generateRows(n: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: 1000 + i,
      name: "用户 " + (i + 1),
      email: "user" + (i + 1) + "@example.com",
      dept: DEPTS[i % DEPTS.length],
      score: (i * 37) % 100,
      status: STATUSES[i % STATUSES.length],
      joined: "202" + (i % 6) + "-" + String((i % 12) + 1).padStart(2, "0") + "-15",
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 状态：全是 signal
// ---------------------------------------------------------------------------
const allRows = signal<Row[]>(generateRows(50000));
const query = signal("");
const sortKey = signal<keyof Row>("id");
const sortDir = signal<"asc" | "desc">("asc");
const scrollTop = signal(0);

// 窗口化参数
const ROW_H = 40;
const VIEWPORT_H = 480;
const OVERSCAN = 6;
const VISIBLE = Math.ceil(VIEWPORT_H / ROW_H) + OVERSCAN * 2;

// 搜索 + 排序后的视图（computed，只在依赖变化时重算）
const view = computed(() => {
  const q = query().trim().toLowerCase();
  let rows = allRows();
  if (q) {
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        r.dept.toLowerCase().includes(q)
    );
  }
  const k = sortKey();
  const dir = sortDir() === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[k];
    const bv = b[k];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
});

const total = computed(() => view().length);
const start = computed(() => Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN));
const end = computed(() => Math.min(total(), start() + VISIBLE));
const windowRows = computed(() => view().slice(start(), end()));

// 点击表头排序：同列切换方向，异列重置为升序
function setSort(key: keyof Row) {
  if (sortKey() === key) {
    sortDir.set(sortDir() === "asc" ? "desc" : "asc");
  } else {
    sortKey.set(key);
    sortDir.set("asc");
  }
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------
function HeaderCell(props: { col: (typeof COLUMNS)[number] }) {
  const c = () => resolve(props.col);
  const sorted = () => sortKey() === c().key;
  return (
    <button class="h" onClick={() => setSort(c().key)}>
      {c().label}
      {sorted() ? (sortDir() === "asc" ? " ▲" : " ▼") : ""}
    </button>
  );
}

function BodyRow(props: { row: Row }) {
  const r = () => resolve(props.row);
  return (
    <div class="cols body-row">
      <span>{r().id}</span>
      <span>{r().name}</span>
      <span>{r().email}</span>
      <span>{r().dept}</span>
      <span>{r().score}</span>
      <span class={"badge " + r().status}>{r().status}</span>
      <span>{r().joined}</span>
    </div>
  );
}

function App() {
  return (
    <div class="app">
      <header class="topbar">
        <h1>Plain · 数据表格</h1>
        <span class="muted">
          共 {total()} 行 · DOM 中恒为 {VISIBLE} 行（窗口化）
        </span>
      </header>

      <section class="card">
        <div class="row">
          <input
            class="input"
            placeholder="搜索姓名 / 邮箱 / 部门…"
            value={query()}
            onInput={(e) => query.set(e.target.value)}
          />
        </div>

        <div class="table">
          <div class="cols head">
            {COLUMNS.map((c) => (
              <HeaderCell col={c} />
            ))}
          </div>

          {/* 视口：滚动时只更新上下占位高度 + 少量可见行 */}
          <div
            class="viewport"
            onScroll={(e) => scrollTop.set((e.currentTarget as HTMLDivElement).scrollTop)}
          >
            <div style={"height:" + start() * ROW_H + "px"} />
            {windowRows().map((r) => (
              <BodyRow row={r} />
            ))}
            <div style={"height:" + (total() - end()) * ROW_H + "px"} />
          </div>
        </div>
      </section>
    </div>
  );
}

mount("#app", App());
