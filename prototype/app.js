// ============================================================================
// 演示应用：用 Plain 写一个“计数器 + 待办列表 + 异步资料卡”
// 全部用单文件单语言写法，逻辑与视图同作用域。
// ============================================================================

import {
  signal,
  computed,
  html,
  when,
  each,
  resource,
  server,
  mount,
} from "./framework.js";

// ---------------------------------------------------------------------------
// 1) 计数器：signal + computed，无 deps 数组、无 hook 顺序
// ---------------------------------------------------------------------------
const count = signal(0);
const doubled = computed(function () {
  return count() * 2;
});

function Counter() {
  return html`
    <section class="card">
      <h2>① 计数器</h2>
      <p class="big">${count}</p>
      <button onclick="${function () { count(count() + 1); }}">
        点我 +1（doubled: ${doubled}）
      </button>
      <button onclick="${function () { count(0); }}">重置</button>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// 2) 待办列表：each（keyed 细粒度）+ when（条件）+ immutable 更新
//    注意：所有更新都生成新数组，没有“原地改忘了触发”的陷阱
// ---------------------------------------------------------------------------
const todos = signal([
  { id: 1, text: "设计框架", done: true },
  { id: 2, text: "写编译器", done: false },
  { id: 3, text: "让 AI 用它造 app", done: false },
]);
let nextId = 4;

const remaining = computed(function () {
  return todos().filter(function (t) {
    return !t.done;
  }).length;
});

function addTodo(e) {
  const input = e.target.previousElementSibling;
  const text = input.value.trim();
  if (!text) return;
  todos.set(
    todos().concat([{ id: nextId++, text: text, done: false }])
  );
  input.value = "";
}

function toggle(id) {
  todos.set(
    todos().map(function (t) {
      return t.id === id ? Object.assign({}, t, { done: !t.done }) : t;
    })
  );
}

function TodoList() {
  return html`
    <section class="card">
      <h2>② 待办（剩 ${remaining} 项）</h2>
      <div class="row">
        <input placeholder="加一条待办，回车或点按钮" />
        <button onclick="${addTodo}">添加</button>
      </div>
      <ul class="todos">
        ${each(
          todos,
          function (t) {
            return t.id;
          },
          function (t) {
            return html`
              <li class="${t.done ? "done" : ""}">
                <input
                  type="checkbox"
                  checked="${t.done}"
                  onchange="${function () { toggle(t.id); }}"
                />
                <span>${t.text}</span>
              </li>
            `;
          }
        )}
      </ul>
      ${when(
        function () {
          return remaining() === 0;
        },
        function () {
          return html`<p class="ok">全部完成 🎉</p>`;
        }
      )}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// 3) 异步资料卡：resource 自带 loading，等价于“服务端取数”
// ---------------------------------------------------------------------------
function fakeFetch() {
  return new Promise(function (resolve) {
    setTimeout(function () {
      resolve({ name: "Ada Lovelace", role: "AI 时代的首席架构师" });
    }, 900);
  });
}

const user = resource(fakeFetch);

function Profile() {
  return html`
    <section class="card">
      <h2>③ 资料卡（异步 / 模拟服务端）</h2>
      ${when(
        function () {
          return user.loading();
        },
        function () {
          return html`<p class="muted">加载中…</p>`;
        },
        function () {
          return html`
            <p><b>${function () { return user.data().name; }}</b></p>
            <p class="muted">${function () { return user.data().role; }}</p>
          `;
        }
      )}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// 4) 显式执行边界：server() 标注的函数只应跑在服务端（编译期剥离）
// ---------------------------------------------------------------------------
const loadConfig = server(function () {
  // 真实项目里这里连数据库 / 读环境变量，绝不会进客户端 bundle
  return { theme: "dark", version: "alpha" };
});

function App() {
  return html`
    <main>
      <header>
        <h1>Plain —— 面向 AI 的迷你框架原型</h1>
        <p class="muted">
          signals + 单文件单语言 + 细粒度 DOM；配置版本：${loadConfig().version}
        </p>
      </header>
      ${Counter()} ${TodoList()} ${Profile()}
    </main>
  `;
}

mount(document.getElementById("app"), App());
