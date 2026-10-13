# Plain 配方（Patterns）

> 目的：常见场景的**唯一推荐写法**。让 AI 第一次就写对，也让人审查时只认一种形状。
>
> 与其它文档的分工：
> - [`README.md`](../README.md)：把一个语言特性讲清楚（这是什么、怎么用）。
> - [`AGENTS.md`](../AGENTS.md)：哪条写法是错的（反模式目录 + 错误码）。
> - **本文件**：一个完整场景该怎么拼（表单、提交、校验……）。
>
> 纪律：**下面每个场景只给一种写法**。若你要用别的写法，先确认它不是在踩第 7 节的坑。

---

## 0. 只有三种状态写法

一切状态问题都收敛到这三条，表单也不例外：

| 你要的东西 | 用什么 | 读法 / 写法 |
| --- | --- | --- |
| 一个会变的值（输入框内容、开关、选了哪项） | `signal(init)` | 读 `s()`，写 `s.set(v)` |
| 一个从别处算出来的值（错误信息、是否可提交） | `computed(fn)` | 读法和 signal 一样 |
| 一份要等外部（网络 / 服务端）的数据 | `resource(fn)` / `server(fn)` | 见第 2、6 节 |

**表单里出现 `reactive` / `useState` / `.value` / `.get()` 一律是错的**（详见 `AGENTS.md` 第 3 节）。

---

## 1. 表单

### 1.1 受控输入（唯一推荐写法）

```tsx
const name = signal("");

<input value={name()} onInput={(e) => name.set(e.target.value)} />
```

就这三步，**没有 `v-model`、没有 `bind`、没有 `useState`**：

1. `value={name()}` —— DOM 跟着状态走（状态一变，输入框立刻同步）；
2. `onInput` —— 把用户输入写回 signal；
3. 文本/文本域类输入**一律用 `onInput`**，不要用 `onChange`（后者在部分浏览器/输入法下要等失焦才触发）。

> 为什么不让框架给一个 `bind(name)`？见第 8 节。这里少一个 API，就少一类"AI 记错名字"的错。

### 1.2 控件速查

| 控件 | 绑定属性 | 事件 | 取值 |
| --- | --- | --- | --- |
| `<input type="text">` | `value={s()}` | `onInput` | `e.target.value` |
| `<textarea>` | `value={s()}` | `onInput` | `e.target.value` |
| `<input type="number">` | `value={s()}` | `onInput` | `Number(e.target.value)`（见 1.5） |
| `<input type="checkbox">` | `checked={s()}` | `onChange` | `e.target.checked` |
| `<input type="radio">` | `checked={s() === v}` | `onChange` | `s.set(v)` |
| `<select>` | `value={s()}` | `onChange` | `e.target.value` |

```tsx
// checkbox：绑 checked，不是 value
<input type="checkbox" checked={done()} onChange={(e) => done.set(e.target.checked)} />

// select：绑 value，用 onChange
<select value={city()} onChange={(e) => city.set(e.target.value)}>
  <option value="bj">北京</option>
  <option value="sh">上海</option>
</select>
```

### 1.3 多字段表单：每字段一个 signal（推荐）

字段不多时，**一个字段一个 signal** 最省心，也最不可能踩坑：

```tsx
const email = signal("");
const password = signal("");

function LoginForm() {
  return (
    <form onSubmit={onSubmit}>
      <input value={email()} onInput={(e) => email.set(e.target.value)} />
      <input
        type="password"
        value={password()}
        onInput={(e) => password.set(e.target.value)}
      />
      <button type="submit">登录</button>
    </form>
  );
}
```

好处：没有对象展开、没有深路径写入，**结构上不可能触发 `PLAIN_E1106`**（就地改数据那条静默失败）。

**一组强相关的字段**（例如要整体提交 / 整体重置）才用单个对象 signal —— 但更新时必须**生成新对象**：

```tsx
const form = signal({ email: "", password: "" });

// 对：生成新对象
form.set({ ...form(), email: e.target.value });

// 错：就地改，signal 用 Object.is 比较，DOM 不会更新（且会被 lint 拦下）
form().email = e.target.value;
```

### 1.4 提交（同步）

```tsx
function onSubmit(e: SubmitEvent) {
  e.preventDefault(); // 表单提交必须挡掉浏览器默认跳转
  save(email(), password());
}

<form onSubmit={onSubmit}>…</form>
```

处理函数写在组件外，只要能拿到需要的 signal 即可；需要 `resolve(props.x)` 的才必须写在组件内（见 3.1）。

### 1.5 数字 / 格式化输入

`e.target.value` 永远是字符串。数字要在写入时转换，空串要单独处理，别让 `Number("")` 变成 `0`：

```tsx
const age = signal(0);

<input
  type="number"
  value={age()}
  onInput={(e) => {
    const v = e.target.value;
    age.set(v === "" ? 0 : Number(v));
  }}
/>
```

---

## 2. 异步提交

### 2.1 基本：loading / error / 禁用按钮

异步动作（提交、删除）用**普通 async 函数 + 两个 signal**，不要用 `resource`（`resource` 是给"自动跟随依赖重取"的场景）：

```tsx
const saving = signal(false);
const error = signal<string | null>(null);

const submit = server(async (data: { email: string; password: string }) => {
  // 这里跑在服务端：落库 / 鉴权 / 校验
  return { ok: true };
});

async function onSubmit(e: SubmitEvent) {
  e.preventDefault();
  saving.set(true);
  error.set(null);
  try {
    await submit({ email: email(), password: password() });
  } catch (err) {
    error.set((err as Error).message); // 给用户看的友好信息
  } finally {
    saving.set(false);
  }
}
```

```tsx
<form onSubmit={onSubmit}>
  <input value={email()} onInput={(e) => email.set(e.target.value)} disabled={saving()} />
  <button type="submit" disabled={saving()}>
    {saving() ? "提交中…" : "提交"}
  </button>
  {error() ? <p className="error">{error()}</p> : null}
</form>
```

要点：
- **`saving` / `error` 是给 UI 用的普通 signal**，不是框架概念，写清楚就行；
- `try / catch / finally` 三件套，避免请求失败后按钮永远卡在"提交中"；
- `server()` 的错误会以 Promise reject 的形式回到客户端，所以在客户端 `catch` 里处理。
- **`server()` 函数名在整个应用里唯一**：清单是单文件，多入口 / 多模块下同名会被构建期
  拦下并报冲突（点名两处来源），不会静默覆盖。

### 2.2 权威校验 + 落库都在 `server()` 里

**服务端不能信任客户端**（这是 `AGENTS.md` 第 3 节第 8、10 条的高频坑）：

```tsx
const createUser = server(async (user: { name: string; age: number }) => {
  // 校验规则写在服务端函数体内部，不要从外面传进来
  if (!user || typeof user.name !== "string" || user.name.trim() === "") {
    return { ok: false, reason: "name 不能为空" };
  }
  if (typeof user.age !== "number" || user.age < 0) {
    return { ok: false, reason: "age 必须是不小于 0 的数字" };
  }
  // …落库…
  return { ok: true };
});
```

反例（都会被拦，别写）：把校验函数当参数传进来、或引用模块作用域的 `validate()` —— 函数体被物理搬到服务端后，那些依赖不在了（`PLAIN_E1007` / `PLAIN_E1006`）。

### 2.3 提交成功后清理

```tsx
batch(() => {
  email.set("");
  password.set("");
});
```

多次写入用 `batch` 包一层，只触发一轮 DOM 更新。

---

## 3. 列表内表单（行内编辑）

### 3.1 行内局部状态 + keyed 复用

一行的"是否在编辑""编辑草稿"是**这一行自己的状态**，应该放进**行组件**里：

```tsx
function TodoRow(props: { item: Todo; onSave: (id: number, text: string) => void }) {
  // 行内局部状态：进入编辑态才有意义，跟着这一行走
  const editing = signal(false);
  const draft = signal("");

  function startEdit() {
    draft.set(resolve(props.item).text); // 用当前文本预填草稿
    editing.set(true);
  }

  return (
    <li>
      {editing() ? (
        <span>
          <input value={draft()} onInput={(e) => draft.set(e.target.value)} />
          <button
            onClick={() => {
              props.onSave(resolve(props.item).id, draft());
              editing.set(false);
            }}
          >
            保存
          </button>
          <button onClick={() => editing.set(false)}>取消</button>
        </span>
      ) : (
        <span onDblClick={startEdit}>{resolve(props.item).text}</span>
      )}
    </li>
  );
}
```

列表侧**必须给顶层元素写 `key`**，行组件的实例（连同它的 `editing` / `draft`）才会跟着数据走：

```tsx
<ul>
  {items().map((item) => (
    <TodoRow key={item.id} item={item} onSave={saveTodo} />
  ))}
</ul>
```

要点：
- 局部状态放**行组件**里，不要把所有行的 `editing` 挤进一个父级 signal（那样重排时会串行）；
- **动态值 props 用 `resolve(props.x)`** —— 它们在编译器里是 getter，直接当值用会渲染出函数源码或停更（见 `AGENTS.md` 第 3 节第 5、9 条）；
- **`on` + 大写开头的 prop 直接调用，绝不 `resolve`**：编译器对 `/^on[A-Z]/` 的 prop（如 `onSave`）原样把函数传进来，`resolve(props.onSave)` 会**当场把它调用掉**（等价于 `props.onSave()`）。所以是 `props.onSave(id, text)`，不是 `resolve(props.onSave)(id, text)`。

### 3.2 统一编辑态（少数场景）

只有"整张表一起进入编辑模式"这种需求，才把状态提到父级：

```tsx
const editingAll = signal(false);
```

不要在"每行各自编辑"里用它 —— 那是 3.1 的场景。

---

## 4. 校验

### 4.1 分层：客户端做 UX，服务端做权威

| 层 | 位置 | 目的 | 能不能信 |
| --- | --- | --- | --- |
| 客户端即时校验 | 组件里的 `computed` | 即时反馈、禁用按钮 | **只做体验，不能当安全边界** |
| 服务端权威校验 | `server()` 函数体内部 | 安全 / 数据正确性 | 唯一可信来源 |

### 4.2 错误面

字段级错误用 `computed` 派生，不要另存一份可能不同步的 state：

```tsx
const email = signal("");
const emailError = computed(() => {
  const v = email().trim();
  if (v === "") return "请填写邮箱";
  if (!v.includes("@")) return "邮箱格式不对";
  return null;
});

const canSubmit = computed(() => emailError() === null);
```

```tsx
<input value={email()} onInput={(e) => email.set(e.target.value)} />
{emailError() ? <p className="error">{emailError()}</p> : null}
<button type="submit" disabled={!canSubmit()}>提交</button>
```

- **派生值用 `computed`，不要在 `effect` 里手动同步一个"错误 signal"** —— 那是 `AGENTS.md` 第 3 节第 12、13 条要拦的写法；
- 服务端返回的 `{ ok: false, reason }` 落到一个 `serverError` signal 里，分开显示（客户端错误 vs 服务端错误）。

### 4.3 什么时候校验

- **即时**：格式类（邮箱、必填）→ `computed`；
- **提交时**：唯一性、权限、业务规则 → `server()`，结果存进 `serverError`。

---

## 5. 路由（cookbook 入口）

路由已有官方写法，直接用，不要自己写 `hashchange` 监听：

```tsx
const router = createRouter({
  routes: [
    { path: "/", component: Home },
    { path: "/user/:id", component: User },
    { path: "*", component: NotFound },
  ],
  mode: "hash", // 或 "history"
});

// 页面切换写成函数调用，插值会自动追踪 router 状态
function currentPage() {
  const m = router.current();
  return m.route ? m.route.component({ params: m.params, path: m.path }) : null;
}
```

组件里拿路由参数：`props.params.id`（`RouteProps`）。完整示例见 [`examples/todo/main.tsx`](../examples/todo/main.tsx)。

## 6. 数据（cookbook 入口）

| 场景 | 用什么 |
| --- | --- |
| 依赖 signal、会自动重取的数据（列表、详情、搜索结果） | `resource(fn)` —— 自带 `data` / `loading` / `error` / `refetch`，并发时丢弃过期响应 |
| 只在服务端跑的代码（读库、读密钥） | `server(fn)` —— 客户端只剩 RPC 桩 |
| 一次性动作（提交、删除） | 普通 async 函数 + `saving` / `error`（见第 2 节），**不要**用 `resource` |

```tsx
// 读：自动跟随依赖重取
const user = resource(() => getUser(props.params.id));

{user.loading() ? <p>加载中…</p> : <p>{user.data()?.name}</p>}
```

---

## 7. 常见坑 → 反模式对照

写上面这些场景时，最容易踩的几条（完整目录见 [`AGENTS.md`](../AGENTS.md) 第 3 节）：

| 场景 | 别写 | 该写 |
| --- | --- | --- |
| 输入框 | `<input value={name} />`（漏调用） | `value={name()}` |
| 输入框回写 | `name = e.target.value` | `name.set(e.target.value)` |
| 多字段对象 | `form().email = v` | `form.set({ ...form(), email: v })` |
| props | `const t = props.title` | `resolve(props.title)` |
| 派生错误 | 在 `effect` 里同步一个 error signal | `computed(...)` |
| 提交 | 忘了 `e.preventDefault()` | 处理函数第一行就挡掉 |
| 校验 | 把校验函数当参数传给 `server()` | 校验写在 `server()` 函数体内 |
| 列表行 | 不写 `key` 却依赖行内局部状态 | `<Row key={item.id} … />` |
| 事件 prop | `resolve(props.onClick)`（会把处理器当场调用） | `props.onClick(...)` —— `on*` prop 不是 getter |
| 透传一组属性 | `<Card {...rest} />` | 逐个显式列出（`PLAIN_E1008`） |

---

## 8. 为什么没有 `v-model` / `bind`

Plain 的取舍是：**少一个概念，就少一类错误**。

- `value={s()}` + `onInput` 已经把"双向"拆成两条单向、且各自可见的线。读代码就能推出行为 —— 这正是本框架的命题。
- 引入 `bind(s)` 会立刻带来新问题：它返回什么？绑 `value` 还是 `checked`？数字怎么转？要不要防抖？——每一个都是 AI 会记错的点，也都是新的文档面。

而且**用 `{...spread}` 自己封装 `bind` 会静默失效**：展开属性只在创建时求值**一次**，不会进入响应式更新。

```tsx
// 看似优雅，实则坏掉：email 变化后输入框不会跟着更新（"重置表单"会失效）
<input {...bindText(email)} />
```

编译产物里，展开是一段**只跑一次**的循环（`setAttribute` / `addEventListener`），而不是 `effect(…)`。
所以编译器现在**直接拒绝**它：`PLAIN_E1008`（见 `AGENTS.md` 第 3 节第 15 条）——
与其留一个"半对"的行为让人静默踩坑，不如在编译期报错，这正是本框架的取舍。

**结论：受控绑定一律写全三件套，不要用 spread 封装。**

```tsx
<input value={email()} onInput={(e) => email.set(e.target.value)} />
```
