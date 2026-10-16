// Plain 示例：一个真实感的应用
//
// 覆盖：signals / computed / batch / 列表（行级响应式）/ 表单双向绑定
//      / 组件 props + children / 路由与参数 / server() 跨端调用
//      / resource 异步 / ErrorBoundary
//
// 约定（编译器要求，README 有完整说明）：
//   · 组件必须写成 `return (<jsx />)` —— 编译期会展开成建 DOM 的代码
//   · 列表用 arr.map(x => <jsx/>)，条件用 {cond ? <a/> : <b/>}
//   · state 只认 signal：读 xxx()，写 xxx.set(v)

import {
  signal,
  computed,
  effect,
  resolve,
  mount,
  createRouter,
  resource,
  server,
  ErrorBoundary,
  batch,
} from "plain";

type Todo = { id: number; text: string; done: boolean };
type CardProps = { title: string | (() => string); children?: any };
type StatCardProps = { label: string; value: unknown };
type RouteProps = import("plain").RouteProps;

// ---------------------------------------------------------------------------
// 服务端函数：编译期会被物理挪到 .plain/server.mjs
// 客户端产物里只有 rpc("xxx", args) 桩，函数体一行都不留下
// ---------------------------------------------------------------------------
const fetchStats = server(async () => {
  return { users: 1024, online: 37, version: "0.3.0" };
});

const checkKeyword = server(async (word: string) => {
  const banned = ["测试", "todo", "aaa"];
  return { ok: !banned.includes(String(word || "").trim().toLowerCase()) };
});

// ---------------------------------------------------------------------------
// 状态：全项目只有 signal 一种状态原语
// ---------------------------------------------------------------------------
const todos = signal<Todo[]>([
  { id: 1, text: "读一遍 Plain 的响应式规则", done: true },
  { id: 2, text: "把 server() 挪到服务端跑", done: true },
  { id: 3, text: "用 .map 渲染列表", done: false },
  { id: 4, text: "接上真实后端", done: false },
]);

const draft = signal("");
const filter = signal<"all" | "active" | "done">("all");
let nextId = 5;

const remaining = computed(() => todos().filter((t) => !t.done).length);

const visible = computed(() =>
  todos().filter((t) =>
    filter() === "all" ? true : filter() === "active" ? !t.done : t.done
  )
);

function addTodo() {
  const text = draft().trim();
  if (!text) return;
  batch(() => {
    todos.set(todos().concat([{ id: nextId++, text, done: false }]));
    draft.set("");
  });
}

function toggleTodo(id: number) {
  todos.set(todos().map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
}

function removeTodo(id: number) {
  todos.set(todos().filter((t) => t.id !== id));
}

// ---------------------------------------------------------------------------
// 组件：手写 DOM 也完全没问题，props 里的动态值统一用 resolve 取
// ---------------------------------------------------------------------------
function Card(props: CardProps) {
  const el = document.createElement("section");
  el.className = "card";

  const head = document.createElement("div");
  head.className = "card-head";
  const headText = document.createTextNode("");
  head.appendChild(headText);
  effect(() => {
    headText.nodeValue = String(resolve(props.title));
  });

  const body = document.createElement("div");
  const kids = props.children ? props.children() : null;
  if (kids) body.appendChild(kids);

  el.appendChild(head);
  el.appendChild(body);
  return el;
}

function StatCard(props: StatCardProps) {
  const el = document.createElement("div");
  el.className = "stat";
  const label = document.createElement("div");
  label.className = "stat-label";
  const value = document.createElement("div");
  value.className = "stat-value";
  const lt = document.createTextNode("");
  const vt = document.createTextNode("");
  label.appendChild(lt);
  value.appendChild(vt);
  el.appendChild(label);
  el.appendChild(value);
  effect(() => {
    lt.nodeValue = String(resolve(props.label));
  });
  effect(() => {
    vt.nodeValue = String(resolve(props.value));
  });
  return el;
}

/** 会抛错的组件：演示 ErrorBoundary */
const boom = signal(false);

function Fragile() {
  return (
    <div class="muted">
      {(() => {
        if (boom()) throw new Error("人为触发的渲染错误");
        return "当前状态正常，子组件渲染成功。";
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面 1：待办列表
// ---------------------------------------------------------------------------
function Home() {
  return (
    <main>
      <Card title="待办清单">
        <div class="row">
          <input
            class="input"
            placeholder="加一条待办，回车也行…"
            value={draft()}
            onInput={(e) => draft.set(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTodo()}
          />
          <button class="btn" onClick={addTodo}>
            添加
          </button>
        </div>
        <div class="row small">
          <span class="muted">剩 {remaining()} 项未完成</span>
          <span class="spacer" />
          <button
            class={filter() === "all" ? "chip on" : "chip"}
            onClick={() => filter.set("all")}
          >
            全部
          </button>
          <button
            class={filter() === "active" ? "chip on" : "chip"}
            onClick={() => filter.set("active")}
          >
            未完成
          </button>
          <button
            class={filter() === "done" ? "chip on" : "chip"}
            onClick={() => filter.set("done")}
          >
            已完成
          </button>
        </div>
        <ul class="todos">
          {visible().map((t) => (
            <li class={t.done ? "todo done" : "todo"}>
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => toggleTodo(t.id)}
              />
              <span>{t.text}</span>
              <a class="detail" href={"#/todo/" + t.id}>
                详情
              </a>
              <a class="del" href="#" onClick={() => removeTodo(t.id)}>
                删除
              </a>
            </li>
          ))}
        </ul>
        {visible().length === 0 ? <p class="ok">这里空了</p> : null}
      </Card>

      <Card title="错误边界">
        <ErrorBoundary
          fallback={(e, retry) => (
            <div class="error-box">
              <strong>已降级：</strong>
              {e.message}
              <button class="btn ghost" onClick={retry}>
                重试
              </button>
            </div>
          )}
        >
          <Fragile />
        </ErrorBoundary>
        <div class="row" style={{ marginTop: "12px", marginBottom: 0 }}>
          <button class="btn ghost" onClick={() => boom.set(!boom())}>
            {boom() ? "关掉错误开关" : "人为触发错误"}
          </button>
        </div>
      </Card>
    </main>
  );
}

// ---------------------------------------------------------------------------
// 页面 2：详情（路由参数 + props 传值）
// ---------------------------------------------------------------------------
function TodoView(props: { todo: Todo }) {
  const t = () => resolve(props.todo);
  return (
    <div>
      <p class="big">{t().text}</p>
      <p class={t().done ? "ok" : "muted"}>
        {t().done ? "已经完成" : "还没完成"}
      </p>
      <button class="btn ghost" onClick={() => toggleTodo(t().id)}>
        切换状态
      </button>
      <a class="link" href="#/">
        返回列表
      </a>
    </div>
  );
}

function Detail(props: RouteProps) {
  const id = () => String(props.params.id);
  const found = () => todos().find((t) => String(t.id) === id());
  return (
    <section class="card">
      <h2 class="card-title">待办 #{id()}</h2>
      {found() ? (
        <TodoView todo={found()!} />
      ) : (
        <p class="muted">找不到 #{id()}，可能已经被删了。</p>
      )}
    </section>
  );
}

function NotFound() {
  return (
    <section class="card">
      <h2 class="card-title">404</h2>
      <p class="muted">这个地址不存在。</p>
      <a class="link" href="#/">
        回到首页
      </a>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 页面 3：服务端数据（走 RPC）
// ---------------------------------------------------------------------------
function Stats() {
  const stats = resource(() => fetchStats());
  const word = signal("");
  const audit = resource(() =>
    word() ? checkKeyword(word()) : Promise.resolve(null)
  );

  return (
    <main>
      <section class="card">
        <h2 class="card-title">服务端数据（server() + RPC）</h2>
        {stats.loading() ? (
          <p class="muted">加载中…</p>
        ) : (
          <div class="stats">
            <StatCard label="用户总数" value={stats.data()?.users} />
            <StatCard label="在线" value={stats.data()?.online} />
            <StatCard label="框架版本" value={stats.data()?.version} />
          </div>
        )}
        <button class="btn ghost" onClick={() => stats.refetch()}>
          重新拉取
        </button>
      </section>

      <section class="card">
        <h2 class="card-title">带参数的 server 调用</h2>
        <div class="row">
          <input
            class="input"
            placeholder="输入一个词试试敏感词校验"
            value={word()}
            onInput={(e) => word.set(e.target.value)}
          />
        </div>
        {word() === "" ? (
          <p class="muted">输入内容后自动调用服务端校验</p>
        ) : audit.loading() ? (
          <p class="muted">校验中…</p>
        ) : (
          <p class={audit.data()?.ok ? "ok" : "warn"}>
            {audit.data()?.ok ? `「${word()}」可以用` : `「${word()}」是敏感词`}
          </p>
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// 根组件 + 路由
// ---------------------------------------------------------------------------
const router = createRouter({
  routes: [
    { path: "/", component: Home },
    { path: "/todo/:id", component: Detail },
    { path: "/stats", component: Stats },
    { path: "*", component: NotFound },
  ],
  mode: "hash",
});

/** 当前页：写成函数调用，插值会自动追踪 router 状态 */
function currentPage() {
  const m = router.current();
  return m.route ? m.route.component({ params: m.params, path: m.path }) : null;
}

function App() {
  return (
    <div class="app">
      <header class="topbar">
        <h1>Plain App</h1>
        <nav>
          <a
            class={router.current().path === "/" ? "nav on" : "nav"}
            href="#/"
            onClick={() => router.navigate("/")}
          >
            待办
          </a>
          <a
            class={router.current().path === "/stats" ? "nav on" : "nav"}
            href="#/stats"
            onClick={() => router.navigate("/stats")}
          >
            统计
          </a>
        </nav>
      </header>
      {currentPage()}
    </div>
  );
}

mount("#app", App());
