// Plain SSR 示例：同一份组件 —— 服务端渲染成「带着数据」的 HTML，客户端注水接管交互
//
// 三处值得对照看：
//   1. `server()` 是**同一份实现**：服务端直调（同进程、不走 HTTP），客户端走 RPC，
//      调用方完全不用区分；
//   2. `resource()` 在服务端取到的值会被收进页面载荷，注水时按**调用点**配对种回来
//      -> 首屏与服务端 HTML 一致：不闪 loading，也不为对齐首屏多请求一次；
//   3. `createRouter` 在服务端靠 `ssrMiddleware` 注入的**请求 URL** 知道该渲染哪一页
//      —— 所以每个地址都有自己的、带数据的 HTML（SEO 要的就是这个）。

import { signal, resource, server, createRouter } from "plain";

type Todo = { id: number; text: string; done: boolean };
type RouteProps = import("plain").RouteProps;

// ---------------------------------------------------------------------------
// 服务端数据。
//
// 注意函数体必须**自包含**（PLAIN_E1006）：它会被物理搬进 .plain/server.mjs，
// 闭包不会跟过去 —— 所以数据写在函数体里。真实项目里应该是
// `await import("./db.js")` 或读 `process.env`（错误提示里也是这么建议的）。
// ---------------------------------------------------------------------------
const listTodos = server(async (): Promise<Todo[]> => {
  return [
    { id: 1, text: "把首屏渲染进 HTML", done: true },
    { id: 2, text: "让注水不重复取数据", done: true },
    { id: 3, text: "接上真实数据库", done: false },
  ];
});

const getTodo = server(async (id: number): Promise<Todo | null> => {
  const all: Todo[] = [
    { id: 1, text: "把首屏渲染进 HTML", done: true },
    { id: 2, text: "让注水不重复取数据", done: true },
    { id: 3, text: "接上真实数据库", done: false },
  ];
  return all.find((t) => t.id === Number(id)) ?? null;
});

/** 注水后才「活」的状态：用它证明服务端渲染出的 HTML 真的被接管了 */
const clicks = signal(0);

function Home() {
  const todos = resource(() => listTodos());
  return (
    <main>
      <h1>待办（服务端渲染）</h1>
      <p class="muted">
        这段 HTML 是服务端直出的：右键「查看网页源代码」就能看到数据，而不是空骨架。
      </p>
      {todos.loading() ? (
        <p class="muted">加载中…</p>
      ) : (
        <ul class="todos">
          {todos.data()!.map((t) => (
            <li class={t.done ? "done" : ""}>
              <a href={"/todo/" + t.id}>{t.text}</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function Detail(props: RouteProps) {
  const id = () => String(props.params.id);
  const todo = resource(() => getTodo(Number(id())));
  return (
    <main>
      <p>
        <a class="back" href="/">
          ← 返回列表
        </a>
      </p>
      {todo.loading() ? (
        <p class="muted">加载中…</p>
      ) : todo.data() ? (
        <article>
          <h2>{todo.data()!.text}</h2>
          <p class={todo.data()!.done ? "ok" : "muted"}>
            {todo.data()!.done ? "已完成" : "未完成"}
          </p>
        </article>
      ) : (
        <p class="muted">找不到 #{id()}。</p>
      )}
    </main>
  );
}

function NotFound() {
  return (
    <main>
      <h2>404</h2>
      <p class="muted">这个地址不存在。</p>
      <a class="back" href="/">
        回到首页
      </a>
    </main>
  );
}

const router = createRouter({
  routes: [
    { path: "/", component: Home },
    { path: "/todo/:id", component: Detail },
    { path: "*", component: NotFound },
  ],
  mode: "history",
});

/**
 * 根组件。服务端导出它（`entry-server.tsx`），客户端注水它（`entry-client.tsx`）——
 * 同一份代码，两条路。
 */
export function App() {
  const m = router.current();
  const page = m.route
    ? m.route.component({ params: m.params, path: m.path })
    : null;
  return (
    <div class="app">
      <header class="topbar">
        <a class="brand" href="/">
          Plain SSR
        </a>
        <span class="muted">服务端渲染 + 首屏数据 + 注水接管</span>
      </header>
      {page}
      <footer class="foot">
        <button class="btn" onClick={() => clicks.set(clicks() + 1)}>
          点了 {clicks()} 次
        </button>
        <span class="muted">
          服务端渲染时它是 0；注水后点一下会动 —— 事件与响应式接上了
        </span>
      </footer>
    </div>
  );
}
