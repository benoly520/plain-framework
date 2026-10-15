# Plain

> A frontend framework that **compiles to the DOM**: TSX views + signals reactivity + an **explicit server boundary**.
> Designed for "AI writes it, humans maintain it" — less inference, fewer concepts, fewer surprises.

```tsx
import { signal, computed, mount, server } from "plain";

const count = signal(0);                       // the only state primitive
const double = computed(() => count() * 2);    // derived value, same read syntax

const now = server(() => Date.now());          // physically moved to the server at compile time

function App() {
  return (
    <button onClick={() => count.set(count() + 1)}>
      clicked {count()} times, doubled is {double()}
    </button>
  );
}

mount("#app", App());
```

---

## Table of Contents

- [Understand Plain in 10 seconds](#understand-plain-in-10-seconds)
- [Core Rules (just 5)](#core-rules-just-5)
- [Install & Run](#install--run)
- [Full API Table](#full-api-table)
- [What the compiler supports / rejects](#what-the-compiler-supports--rejects)
- [server(): the explicit execution boundary](#server-the-explicit-execution-boundary)
- [SSR & Hydration](#ssr--hydration)
- [HMR (Hot Module Replacement)](#hmr-hot-module-replacement)
- [Tooling: plaindev](#tooling-plaindev)
- [Designed for AI](#designed-for-ai)
- [Boundaries & Known Limitations](#boundaries--known-limitations)
- [Testing & Quality](#testing--quality)
- [Examples](examples/todo/)
- [Directory Structure](#directory-structure)
- [License](#license)

---

## Understand Plain in 10 seconds

| Dimension | Traditional frameworks | Plain |
| --- | --- | --- |
| Views | hand-written VNodes / DOM diffing | **compiled to DOM-building code**, no virtual DOM at runtime |
| State | useState / ref / reactive / store — many options | **only `signal`** |
| Dependency tracking | deps arrays / manual memo | automatic, **no deps arrays** |
| Side-effect ordering | hook order must be stable | order-free, **no hook rules** |
| Component boundary | implicit (everything in the browser) | **`server()` is explicit**, physically stripped at compile time |
| Safety | `innerHTML` is one keystroke away | **the compiled output cannot contain `innerHTML`** |

The generated code looks roughly like this (readable, debuggable, grep-able):

```js
const __el1 = document.createElement("button");
__el1.addEventListener("click", () => count.set(count() + 1));
__effect(() => { __t2.nodeValue = __stringify(count()); });
__effect(() => { __t3.nodeValue = __stringify(double()); });
```

---

## Core Rules (just 5)

1. **State is only `signal`**: read `s()`, write `s.set(v)` or `s.set(prev => next)`. Derive with `computed(fn)`, same read syntax. No `useState` / `ref` / `reactive` / `.value` / `.get()` branches.
2. **A component is "a function that returns JSX"**, and it must be written as `return (<jsx />)` (the compiler expands it into DOM-building code).
3. **Lists use `arr.map(x => <li/>)`, conditions use `{cond ? <a/> : <b/>}` or `{cond && <a/>}`.**
   Compiled into `each()` / `when()`, with row-level reactivity enabled automatically — no memo needed.
   If you want **nodes to follow the data** (head insertion / reordering without rebuild), give the top-level element a key:
   `arr.map(x => <li key={x.id}>…</li>)`. No key means position-based reuse — both are valid, just different semantics.
4. **Side effects use `effect(fn)`**, dependencies are collected automatically; they are reclaimed together with the component / list row, and `onCleanup` is available for extra cleanup.
5. **Code that must run on the server is wrapped in `server()`.** The client output keeps only an RPC stub.

> Inside a component, always read props with `resolve(props.x)` — the compiler passes dynamic attributes as getters,
> so when the parent's state changes, the child updates automatically, and only the lines that actually use it are updated.

---

## Install & Run

```bash
pnpm add -D vite      # the only hard dependency (besides typescript)
pnpm add plain

npx plaindev dev          # dev: dev server + /_plain/rpc
npx plaindev build        # build: emit dist/ and .plain/server.mjs
npx plaindev serve dist   # production: static hosting + RPC, one command
```

`vite.config.js`:

```js
import { defineConfig } from "vite";
import plain from "plain/vite";

export default defineConfig({
  plugins: [plain()],
  resolve: { alias: { plain: "plain" } },
});
```

`tsconfig.json` —— `jsx: "preserve"` is **required** (Plain handles JSX itself):

```json
{
  "compilerOptions": {
    "jsx": "preserve",
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "baseUrl": ".",
    "paths": { "plain": ["node_modules/plain/dist/index.d.ts"] }
  }
}
```

---

## Full API Table

The entire runtime API is just this. **Convention: the public API surface is frozen; adding anything is a breaking change.**

### Reactivity

| API | Description |
| --- | --- |
| `signal(init)` | the only state primitive. `s()` reads, `s.set(v)` writes, `s.peek()` reads without creating a dependency |
| `computed(fn)` | derived value, same read syntax as `signal` |
| `effect(fn)` | side effect, returns `{ dispose() }`; reclaimed with the component / list row lifecycle |
| `batch(fn)` | coalesce multiple writes into a single update round |
| `createScope(fn)` | create a scope that can be reclaimed as a whole |
| `onCleanup(fn)` | register an unmount callback |
| `resolve(v)` | read a value: if it's a getter, call it; otherwise return as-is (use this uniformly inside components) |

### DOM

| API | Description |
| --- | --- |
| `mount(selOrEl, node)` | mount, returns an unmount function |
| `insert(parent, get)` | insert the result of any expression (generated by the compiler, also usable by hand) |
| `when(parent, cond, then, else)` | conditional rendering (generated by the compiler) |
| `each(parent, getter, itemFn, keyFn?)` | list rendering (generated by the compiler). With `keyFn` → keyed reuse; otherwise position-based |
| `createSlot(label?)` | an anchored slot: return it when a component needs to **replace its own content wholesale afterward** |
| `place(parent, node)` | the compiler's unified entry for mounting components (compatible with Node / Fragment / Slot) |
| `ErrorBoundary` | downgrade a subtree in place on error |
| `hydrate(el, App, opts?)` | SSR hydration: reuse server nodes, auto-read the first-paint payload, returns `{ dispose, warnings }` |
| `hmrApply(id, newMod)` | hot-swap the mount point of a module (usually called by the vite plugin, no need to write by hand) |

### Async & Cross-environment

| API | Description |
| --- | --- |
| `resource(fn)` | returns `{ data, loading, error, refetch }`; signals read inside `fn` auto-refetch and stale responses are discarded |
| `server(fn)` | physically stripped to the server at compile time; the client becomes an RPC stub |
| `rpc(name, args)` | low-level call (rarely written by hand) |
| `setRpcEndpoint(url)` | change the RPC endpoint (when deployed under a sub-path) |
| `setRpcBatching(enabled)` | enable RPC request batching: multiple `rpc` calls in the same microtask become one batched request; old servers degrade gracefully |

### Cross-layer values (Context)

| API | Description |
| --- | --- |
| `createContext<T>(default)` | create a Context (**a default is required**: reading it without a Provider won't silently become `undefined`) |
| `<Ctx.Provider value={…}>…</Ctx.Provider>` | provide a value within a subtree (a normal component tag, no compiler changes needed) |
| `useContext(Ctx)` | returns a **callable getter**, read as `useContext(Ctx)()` — same as `signal`, structurally impossible to snapshot a stale value |
| `Context<T>` | type: the type of `value` and the return of `useContext` is decided in one place via `createContext<T>`; passing/reading wrong is a `tsc` error |

> Request-scoped data (current user / session) should go through Context or props, **not a module-scope signal** —
> under SSR the latter leaks between requests in the same process. Design & acceptance: [`docs/rfcs/context-and-ssr-isolation.md`](docs/rfcs/context-and-ssr-isolation.md).

### Routing

```tsx
const router = createRouter({
  routes: [
    { path: "/", component: Home },
    { path: "/user/:id", component: User },
    { path: "*", component: NotFound },
  ],
  mode: "hash", // or "history"
});

// Page switching is written as a function call; interpolation tracks router state automatically
function currentPage() {
  const m = router.current();
  return m.route ? m.route.component({ params: m.params, path: m.path }) : null;
}
```

`Link` components and `navigate(to)` are provided by `router`; route switches **automatically reclaim the previous page's effects**.

---

## What the compiler supports / rejects

### Supported

```tsx
// 1. Component: return (<jsx />)
function Card(props) {
  return (<section className="card">{props.children()}</section>);
}

// 2. List (keyed → key-based node reuse; otherwise position-based)
<ul>{todos().map(t => <li key={t.id} className={t.done ? "done" : ""}>{t.text}</li>)}</ul>

// 3. Conditions (arbitrarily nested)
{loading() ? <p>loading</p> : error() ? <p>{error().message}</p> : <div>{data().name}</div>}

// 4. Logical AND
{user() && <span>{user().name}</span>}

// 5. Inline functions (compiled to real functions, not strings)
<StatCard label="users" value={() => stats().users} />

// 6. Events
<button onClick={(e) => submit(e)}>submit</button>

// 7. Imperative escape hatch: grab this element (built-in elements only)
<canvas ref={(el) => { el.getContext("2d"); }} />
```

### Imperative escape hatch `ref`

The component body can't get the DOM nodes it creates. When you need imperative operations (`dialog.showModal()` / `canvas.getContext()` /
`video.play()` / a third-party library needs a node), use `ref={(el) => …}` **on a built-in element**:

```tsx
<canvas ref={(el) => {            // el's type is inferred from the tag: HTMLCanvasElement
  const ctx = el.getContext("2d");
  draw(ctx);
  return () => { /* cleanup on element reclaim (optional) */ };
}} />
```

- **When called**: once after the element is **connected to the document** (≈ platform `connectedCallback`) — so
  APIs like `showModal()` that "must be called while in the document" are safe to use.
- **Return value**: an optional cleanup function, reclaimed with the element / component (≈ `disconnectedCallback`).
- **Scope**: the callback runs in the element's owner scope; **put any reactive logic for this node inside the callback**
  (the component body's statements run before DOM construction, when the node doesn't exist yet).
- **Only on built-in elements**: writing `ref` on a component is a compile error (a component doesn't guarantee a root node).
- Not executed during SSR; executed once after hydration.

Trade-offs & acceptance: [`docs/rfcs/ref-escape-hatch.md`](docs/rfcs/ref-escape-hatch.md).

### Not supported —— **compile-time error with a line number**

| Writing | Reason | Fix |
| --- | --- | --- |
| `.map()` returning non-JSX | can't compile into DOM directives | return JSX |
| `innerHTML` / `insertAdjacentHTML` | security red line | use `{expr}` interpolation |
| `useState` / `useEffect` etc. (React APIs) | not Plain APIs | `signal` / `effect` |
| JSX attribute spread `{...expr}` (`PLAIN_E1008`) | spread is half-implemented: no reactivity + bypasses class / style / value, fails silently | expand into explicit attributes |

The compiler has a final **self-check**: if any JSX remains unhandled, or the output can't be parsed, it throws immediately.
**It will not silently hand bad code to the bundler.**

**A deliberate trade-off**: writing both `key=` and the index parameter in a list will **fail to compile directly** (`PLAIN_E1005`)
instead of silently dropping one. Reason: under keyed reuse a row is built only once, so an index captured by the callback can't follow position changes —
having both active means one of them is semantically wrong, and **silent semantic downgrade** is exactly the failure mode this framework wants to eliminate.

### Error codes (one set)

The compiler, linter, and build step **share the same `PLAIN_Exxxx` numbering** — machines only need to remember one prefix.
`error.code` / `error.file` / `error.line` / `error.column` / `error.hint`; `JSON.stringify(error)` gets it all.

Numbering is self-categorizing: `E10xx` compiler internal · `E11xx` lint (suppressible) · `E2xxx` build-time gate.

| Code | Meaning |
| --- | --- |
| `PLAIN_E1001` | JSX landed in a form the compiler doesn't recognize (with a hint on the correct form) |
| `PLAIN_E1002` | the output can't be parsed (usually because the input wasn't type-stripped first) |
| `PLAIN_E1003` | JSX remains in the output (compiler bug) |
| `PLAIN_E1004` | an unsupported syntax node was encountered (compiler bug) |
| `PLAIN_E1005` | a list's `key` and index parameter used together (pick one) |
| `PLAIN_E1006` | a `server()` body references an external variable (the closure won't follow it to the server) |
| `PLAIN_E1007` | a `server()` argument / return value can't be JSON-serialized (function / class instance / Stream) |
| `PLAIN_E1008` | JSX attribute spread `{...expr}` (half-implemented, fails silently) |
| `PLAIN_E1009` | `ref` used on a component (a component has no stable root node) |
| `PLAIN_E1010` | `ref`'s value isn't a function (should be `ref={(el) => …}`) |
| `PLAIN_E1011` | `ref` callback is `async` (cleanup is incompatible with async) |
| `PLAIN_E2001` | contract check failed (thrown by the build pipeline, `plaindev check --fix` can auto-fix) |

**Contract checks are wired into the build pipeline by default** (`plainPlugin({ lint: "warn" | false })` to adjust),
so the AI's common mistakes will **fail the build** rather than blow up at runtime:

| Contract rule (code) | Intercepted writing | Auto-fixable? |
| --- | --- | --- |
| `PLAIN_E1101` | `count = 1` | ✅ change to `count.set(1)` |
| `PLAIN_E1102` | `{count}` / `checked={done}` | ✅ add the call |
| `PLAIN_E1103` | `useState` / `useEffect` / … | ❌ different semantics, error only |
| `PLAIN_E1104` | `el.innerHTML = …` | ❌ security red line, error only |
| `PLAIN_E1105` | `const { title } = props` / `function Card({ title })` | ❌ two fixes have different semantics, error only |
| `PLAIN_E1106` | `items().push(x)` / `todos()[0].done = true` / `const a = items(); a.push(x)` | ❌ error only |
| `PLAIN_E1107` / `PLAIN_E1112` | `const t = props.title` / `{props.title}` / `let t; t = props.title` | ❌ inline resolve vs thunk differ semantically, error only |
| `PLAIN_E1108` | `resolve(props.onClick)` | ✅ remove resolve → `props.onClick` |
| `PLAIN_E1109` | `effect(async () => { await … })` | ❌ dependency collection breaks after await, error only |
| `PLAIN_E1110` | `effect(() => count.set(count() + 1))` | ❌ self-trigger stack-overflows, error only (clamped form doesn't error) |
| `PLAIN_E1111` | `computed(() => { s.set(…) })` | ❌ derived values must be pure, error only |
| `PLAIN_E1113` | `resource()` created at module scope (runs on import / SSR import fires a request) | ❌ move into component / `createScope`, error only |
| `PLAIN_E1114` | reading a property directly off `useContext(Ctx)`'s return (it's a getter) | ❌ call first: `useContext(Ctx)()`, error only |

> Each code also has a **readable short name** (`PLAIN_E1107` = `no-props-snapshot`), full index in `src/errors.ts`;
> the old `plain/no-props-snapshot` form is still accepted in suppression directives (backward compatible), but output is unified to the new code.

For the AI agent's full anti-pattern catalog, see [`AGENTS.md`](AGENTS.md). The compiler side also blocks functions / class instances / Streams in `server()`'s arguments and return values (`PLAIN_E1007`).

Rules are heuristic; when you confirm a false positive, use a **line-level suppression directive** (only works on lint rules; the compiler's `PLAIN_E*` can't be suppressed):

```js
const t = props.title; // plain-ignore-line PLAIN_E1112
// plain-ignore-next-line
effect(() => count.set(count() + 1));
```

Omitting the rule code suppresses all rules on that line; `plaindev check` reports how many suppressions there are — suppression is *visible*, not a mute switch.

```
[PLAIN_E1001] Counter.tsx:8:11  JSX at these positions is not recognized by the compiler: Counter.tsx:8
  hint: write components as 'return (<jsx/>)'; lists as 'arr.map(x => <jsx/>)'; conditions as '{cond ? <a/> : <b/>}' or '{cond && <a/>}'
```

---

## server(): the explicit execution boundary

This is Plain's most important design: **"where does this code run" is visible right in the source**.

```tsx
const db = server(async (id: string) => {
  const secret = process.env.DB_URL;      // only exists on the server
  return await query(secret, id);
});

function User(props) {
  const user = resource(() => db(props.params.id));   // client calls exactly the same way
  return <p>{user.data()?.name}</p>;
}
```

After compilation:

- **Client output**: `const db = (...args) => rpc("db", args);` — not a single line of the function body remains
- **Server manifest `.plain/server.mjs`**: the full function body + `__plainHandlers` summary
- **dev**: `plaindev dev` provides `/_plain/rpc` out of the box
- **production**: `plaindev serve dist`, or mount the middleware in your own Node service:

```js
import { rpcMiddleware } from "plain/server";
app.use(rpcMiddleware({ manifest: ".plain/server.mjs" }));
```

**Boundary notes:**

- Variables referenced inside `server()` **must be obtained serializably on their own** — the function body is physically moved, the closure won't follow.
  This is deliberate: it surfaces "cross-environment data dependencies" in the open.
- Arguments and return values go through JSON, **don't pass functions, class instances, or Streams**.
- Do auth inside `server()` (it runs in your server process).
- **Function names must be unique across the whole app.** The manifest is a single file (`.plain/server.mjs`); under multi-entry / multi-module,
  same-named `server()` functions will be **caught at build time and reported as a conflict** (naming both source files), instead of silently overwriting each other —
  a client RPC stub still calling the old name while the server implementation has been replaced by another is the most expensive failure mode here.
  Vite's entry `input`, shared chunk, and other bundling configs pass through as usual; the framework doesn't intervene.

---

## SSR & Hydration

Plain's compiled output is "build DOM directly + run effects synchronously on first build", so SSR needs no separate renderer — **just swap in a different `document` implementation** (`src/server/dom-shim.ts`, zero dependencies).

```js
import { renderToString, renderToStringSync, renderToStringWithData } from "plain/server";

const html = renderToStringSync(App);                    // synchronous part (resource stops at loading)
const { html, data } = await renderToStringWithData(App, { // wait for resource to settle + collect first-paint payload
  handlers: await loadHandlers(),                        // server() called directly (no HTTP to self)
  url: req.url,                                          // router renders by request URL
});
```

### First-paint data: `server()` + `resource()` is the only pattern

No `loader()` / `getServerSideProps` concepts — one chain connects "data is already there on first paint":

| Step | What happens |
| --- | --- |
| Server | `server()` is **called directly** in the same process (doesn't fetch itself); after rendering, **wait for all `resource`s to settle** (not guessing a millisecond count) |
| Collect | the compiler injects a **call-site key** into each `resource(...)` (e.g. `app.tsx:19#0`), collected into `data` by **creation order** |
| Transfer | `data` is written into the page's `<script type="application/json" id="plain-data">`; `hydrate` reads it back itself |
| Hydrate | paired by creation order into "the queue of that same key" → first frame matches the HTML (no loading flash, no extra request) |
| After | one **SWR background revalidation** still runs: `promiseFn` runs as usual, so dependency changes still refetch (no responsiveness sacrificed) |

**Hydration**: `hydrate` reuses the server-rendered real nodes (**node identity is preserved**, no whole-tree rebuild),
fixing text/attribute mismatches in place, then events and reactivity work as usual.

```js
import { hydrate } from "plain";

const { dispose, warnings } = hydrate(document.getElementById("app"), App);
```

SSR serialization preserves `plain-` prefixed comment anchors (`<!--plain-[-->…<!--plain-]-->`),
which hydration uses to locate dynamic ranges; ordinary comments are still dropped. Hydration and SSR are同源: both run the same compiled output,
and `mount()` (un-hydrated) behaves exactly the same.

### Starting the production server

```js
import { serve } from "plain/server";

await serve({
  dist: "dist",
  ssr: { template: "dist/index.html", entry: ".plain/ssr/entry-server.js" },
});
```

The template needs two placeholder comments (**missing or duplicated both throw immediately**, no silent page with no data):
`<!--plain-ssr-->` (app HTML, placed **inside** the container) and `<!--plain-data-->` (payload script, placed **outside** the container).
A complete runnable example is in [`examples/ssr/`](examples/ssr): `pnpm run build:example:ssr` to build,
`pnpm run start:example:ssr` to serve (open the page source of `/todo/2` to see that data row).

**Cache for hits, skip whole-page re-render (optional)**: give `ssr` a `cache` option, caching the rendered whole-page HTML by **full URL (with query)** + TTL,
serving directly on hit without re-rendering:

```js
await serve({
  dist: "dist",
  ssr: {
    template: "dist/index.html",
    entry: ".plain/ssr/entry-server.js",
    cache: { ttl: 30_000, max: 1000 },   // ttl 0 = never expire (evict by max), max default 1000
  },
});
```

Only written to cache after **successful** rendering (500s etc. don't enter cache and don't pollute other hits); concurrent same-URL requests are auto-deduped (thundering herd guard).
**Don't enable in dev** — once code changes the cache is stale (dev SSR goes through the vite plugin path, not this middleware).

**First-byte optimization (optional)**: give `ssr` a `stream: true`, the middleware immediately **flushes the "shell before the first placeholder"**
(`<head>` / container etc.) so the browser starts fetching CSS·JS early, then writes the rest in chunks once `resource()` data arrives
(and sets `x-accel-buffering: no` to prevent reverse-proxy buffering of the whole page). Streaming and non-streaming have **identical final bytes**,
client hydration is unaffected. `stream` and `cache` can be enabled together (instant on hit, stream only when missed).
Note it grabs "first byte / early resource fetch", **not** "content appearing segment by segment with data" — the latter needs client streaming hydration, not yet done in this framework.

**No build needed in dev**: give the vite plugin a **source** entry, page navigation is handed to server-side rendering (changes take effect immediately,
`server()` direct calls use the in-memory dev registry and don't depend on `.plain/server.mjs`):

```js
// vite.config.js
plain({ ssr: { entry: "./entry-server.tsx" } });   // example: pnpm run dev:example:ssr
```

> Resource references in the template should use **absolute paths** (`/entry-client.tsx`, not `./entry-client.tsx`):
> SSR pages may be nested addresses like `/todo/2`, relative paths resolve to `/todo/entry-client.tsx` — the first-paint HTML is fine,
> but the client script 404s. Absolute paths point to the project root in both dev and after build.

> **Concurrency safety**: during SSR `globalThis.document` is an accessor that "looks up the current render context on read"
> (not swap global then swap back), each render runs in its own `AsyncLocalStorage` scope — concurrent renders in the same process don't cross-contaminate.
> Root cause and fix: [`docs/rfcs/ssr-data.md`](docs/rfcs/ssr-data.md) §3.4.
> After `renderToString` finishes, effects created during SSR are reclaimed, avoiding pollution of subsequent hydration in the same process.

---

## HMR (Hot Module Replacement)

Under dev (vite), changing a Plain module **doesn't full-page refresh**: it only rebuilds the DOM subtree of the relevant mount point
(`syncRange` replaces the anchor range). **Be explicit about what's preserved and what's lost**:

- **Preserved**: window scroll, DOM **outside the anchor range** (node identity unchanged, their focus / input / local scroll intact),
  and the original values of module-level `signal`s — this is the only "actively carried over" state; if it can't be preserved it will be **explicitly warned** in the console, never silently reset;
- **Lost**: DOM state **inside** the rebuilt subtree — focus / selection, uncontrolled input values, local scroll,
  third-party component instances (Monaco etc. will be destroyed by the `ref` cleanup and rebuilt). Controlled input values come back,
  because the value lives in the `signal` and re-rendering restores it.

In other words: HMR's granularity is the **anchor range**, not the node. The boundary is pinned by `test/hmr.test.mjs`.
The vite plugin enables it by default; disable with `plain({ hmr: false })`.

```js
// vite.config.js
import plain from "plain/vite";
export default { plugins: [plain()] };              // dev gets HMR
```

Low-level runtime APIs (rarely written by hand): `hmrApply(id, newMod)` / `snapshotSignals` /
`restoreSignals`; the plugin injects `import.meta.hot.accept` for each module and associates the module id automatically.

---

## Tooling: plaindev

```bash
plaindev check [dir] [--no-fix]     # contract check + auto-fix common errors
plaindev schema [dir] [--out f]     # output machine-readable component contract JSON
plaindev dev [root] [--port n]      # dev server (with RPC)
plaindev build [root] [--out-dir d] # production build
plaindev serve [dist] [--port n]    # production hosting + RPC
plaindev agent-context [--write]    # print the rules context for AI (from AGENTS.md)
                                    # --write persists to AGENTS.md / copilot / cursor, won't overwrite existing files
plaindev mcp                        # MCP stdio server: expose check / schema to AI IDE
plaindev lsp                        # LSP stdio server: real-time editor diagnostics (didOpen/didChange)
```

### `check`: fix the AI's typical mistakes directly

```bash
$ plaindev check src
src/Counter.tsx
  x src/Counter.tsx:8:3   [PLAIN_E1101]     can't assign to signal variable "count" directly, use "count.set(...)"
  x src/Counter.tsx:14:10 [PLAIN_E1102] signal must be called to read: "{count()}"
  -> auto-fixed and written back to src/Counter.tsx
```

Auto-fixable (AST location + source slicing, no regex replacement):

| Rule | Code | Auto-changed to |
| --- | --- | --- |
| `PLAIN_E1101` | `count = v` | `count.set(v)` |
| `PLAIN_E1102` | `{count}` / `checked={done}` | `{count()}` / `checked={done()}` |
| `PLAIN_E1103` | `useState(...)` | error only (different semantics, can't blindly change) |
| `PLAIN_E1104` | `el.innerHTML = ...` | error only (security red line) |

### `schema`: machine-readable contract for AI / CI / IDE

```json
{
  "file": "main.tsx",
  "components": [
    {
      "name": "TodoView",
      "props": [{ "name": "todo", "optional": false, "type": "Todo" }],
      "propsSource": "declared",
      "renders": ["div", "p", "button"]
    }
  ],
  "serverFunctions": [{ "name": "fetchStats", "params": [], "async": true }],
  "routes": [{ "path": "/todo/:id", "component": "Detail" }]
}
```

The fact source of `props` is **the type the component declares itself** (`props: CardProps`), not guessed:

- `propsSource: "declared"` —— resolved by the declared type: `optional` from `?`, `type` from annotation;
- `propsSource: "declared-unresolved"` —— declared a type but can't resolve it (cross-file, `Pick<…>` etc.),
  then attaches `declaredType` and falls back to inference, **won't pretend to resolve successfully**;
- `propsSource: "inferred"` —— component wrote no type annotation, falls back to "what was read + what call sites passed" old inference;
- when declaration and inference disagree, `inferredProps` is also given, so the AI can see at a glance where the "guess" went wrong.

> "Under/over-passing props" is **not** validated by schema —— Plain uses TS, and JSX types are tightened,
> `tsc` reports it at compile time (see `test/types.test.mjs`). The value of schema is giving the AI a contract **without reading all the code**,
> not re-inventing a type checker.

With this JSON, an agent knows "what can be changed in this file, what cross-environment calls exist" without reading the whole file first —
this is the key step to reduce inference load.

---

## Designed for AI

Every design decision in Plain corresponds to "a mistake AI commonly makes":

| AI's common failure mode | Plain's response |
| --- | --- |
| forgetting deps arrays / memoized values going stale | automatic dependency collection, **no deps array concept** |
| wrong hook order / conditional hook calls | **no hook concept**, `effect` is just a plain function |
| mixing state frameworks (`ref` + `reactive` + `store`) | **only `signal`**, one read syntax |
| forgetting `.value` / missing `()` in JSX | contract check **auto-fixes** `{count}` → `{count()}` |
| writing server code into the browser (leaking secrets) | compile-time **physical stripping**, leaking is structurally impossible |
| `innerHTML` string concatenation → XSS | compiled output **doesn't generate innerHTML**; interpolation always goes through text nodes |
| list updates not working (mutation / wrong key) | row-level reactivity automatic, **no key needed** |
| not knowing where to start after a big JSX change | `plaindev schema` gives a structure summary; output is straight-line DOM-building code, readable and debuggable |

---

## Boundaries & Known Limitations

### Completed and verified

- ✅ signals / computed / effect / batch / scope reclamation (no leaks)
- ✅ compile to DOM, zero virtual DOM, zero innerHTML
- ✅ list row-level reactivity, conditional branch reclamation, index-based reuse
- ✅ component props / children / inline function props
- ✅ routing (history / hash / `:param` / `*` ), switch reclaims
- ✅ `resource` async (race discard) and error states
- ✅ `ErrorBoundary` downgrade in place
- ✅ `server()` compile-time physical stripping + dev / production RPC chain
- ✅ SSR output (`renderToStringSync` / `renderToString`)
- ✅ **SSR hydration**: `hydrate(container, App)` reuses server nodes (identity preserved), fixes in place, interaction works
- ✅ **SSR first-paint data**: `server()` direct call + wait-for-settle + `renderToStringWithData` collects payload +
  compiler injects call-site key + hydration pairs and seeds (first frame matches HTML); `ssrMiddleware` / `serve({ ssr })` one line.
  Concurrency isolation (`AsyncLocalStorage`), example [`examples/ssr/`](examples/ssr). Design:
  [`docs/rfcs/ssr-data.md`](docs/rfcs/ssr-data.md)
- ✅ **dev SSR**: give the plugin a **source** entry (`plain({ ssr: { entry } })`) — goes through vite's
  `ssrLoadModule` + in-memory dev registry + `transformIndexHtml`, no pre-build needed, changes take effect immediately
- ✅ **HMR**: in dev, changing a component only hot-swaps the DOM subtree (no full refresh), module-level signal values best-effort preserved
- ✅ CLI: check / schema / dev / build / serve
- ✅ TypeScript types (incl. JSX types, `tsc --noEmit` passes)
- ✅ list keyed reuse (`key={...}`): head insertion / reordering doesn't rebuild existing nodes
- ✅ **imperative DOM escape hatch** `ref={(el) => …}`: called after element connected to document (≈ `connectedCallback`),
  can return cleanup, list / branch reclamation correct, SSR skipped, executed after hydration; `PLAIN_E1009`–`E1011` compile-time interception
- ✅ **Context (cross-layer values) + SSR request-scoped isolation**: `createContext` / `<Ctx.Provider>` / `useContext`
  (same read as signal, structurally can't snapshot a stale value); scope reclaimed with parent owner; request-scoped data finally has a correct home,
  eliminating "module-scope signal cross-request contamination"; `PLAIN_E1114` blocks "reading property directly"
- ✅ **tightened JSX types**: built-in elements drop `[attr: string]: any` — misspelled attribute names / wrong types (`scr` /
  `checked="yes"` / `onClikc`) error immediately in editor and `tsc`; `data-*` / `aria-*` plus common attributes / events fully added;
  unknown tags stay loose. `test/types.test.mjs` pins it with real `tsc` (prevents the index signature from being added back)
- ✅ **declarative contract**: `plaindev schema`'s props follow the component's **declared type** (with `type` and `optional`),
  falls back to inference and labels `declared-unresolved` if unresolvable — no pretending; "under/over-passing props" is left to `tsc`, no re-invented checker
- ✅ **HMR covers all modules**: previously only "mount module + exports `App` / `default`" could hot-swap; changing an independent component file or
  `import()` lazy module would **silently keep old code**; now it goes through "re-run the mount point's root component" (no full refresh),
  and explicitly warns + full-refreshes when the root component can't be recognized
- ✅ structured compile errors (`PLAIN_E100x` + file/line/column/hint, JSON-serializable)
- ✅ `server()` self-contained validation (`PLAIN_E1006`): referencing external variables is a **compile-time** error, no more runtime `ReferenceError`
- ✅ `server()` argument and return value serializability validation (`PLAIN_E1007`): functions / class instances / Streams are compile-time errors
- ✅ compiled output line-level sourcemap, chained back to devtools via vite
- ✅ contract check **wired into the build pipeline by default** (`lint: "warn" | false` adjustable): AI's typical mistakes fail the build
- ✅ `AGENTS.md` + anti-pattern catalog (20 items all statically checked; those untypeable aren't guessed)
- ✅ AI discoverability: `plaindev agent-context [--write]` persists rules to cross-tool standard `AGENTS.md`
  (plus `.github/copilot-instructions.md` and `.cursor/rules/*.mdc` as fallback, existing files not overwritten);
  `plaindev mcp` exposes `check` / `schema` to AI IDE; `plaindev lsp` turns the **same rule chain** into
  **real-time editor diagnostics** (report on write, no need to wait for dev / build); confirmed false positives use line-level suppression directives
- ✅ AI correctness eval skeleton `eval/` (tasks + acceptance assertions + metric definitions)
- ✅ 264 unit tests (19 kernel + 245 unit) + 23 real Chromium end-to-end
- ✅ coverage metrics and gates (c8: line 90% / branch 82% / function 85%), CI enforced no regression

### Not yet implemented (no pretending)

Staged plan and acceptance criteria in [`ROADMAP.md`](ROADMAP.md). Current state:

| Gap | Impact | Priority |
| --- | --- | --- |
| **Component-level (fine-grained) hot-swap** | currently the finest granularity is "mount point": changing a module used elsewhere re-runs the mount point's root component (loses focus / scroll), instead of swapping only that subtree | P2 |
| **SSR streaming (suspense-style progressive content)** | current `stream` only does "flush shell first for first-byte", content still written in one chunk after data arrives (route caching + chunked streaming landed) | P3 |
| **RPC request batching / debounce** | high-frequency calls each fire one request (optional `setRpcBatching` request merge provided, see [`src/runtime/async.ts`](src/runtime/async.ts)) | P1 |
| **Multi-entry / code splitting** | framework side (manifest isolation) landed, bundler side goes through Vite config; demo in [`examples/multi-entry/`](examples/multi-entry) | P1 |
| **Dynamic `import()` Plain module HMR** | lazy module hot-swap coverage tests still pending (root cause fixed, see ROADMAP M7) | P2 |

> ⚠️ **On "concurrent rendering / time slicing"**: it's **not a to-do, but an explicit non-goal** (see [`ROADMAP.md`](ROADMAP.md) "Non-goals"). The earlier table mistakenly listed it as P2, now corrected — it conflicts with the core trade-off of "compile to DOM, stable small core", and is not planned.
>
> HMR and SSR hydration are both landed (see the two sections above and [`ROADMAP.md`](ROADMAP.md) M4/M5).

### Deliberate design trade-offs (not bugs)

- **Components must be `return (<jsx />)`** — restricts the writing, in exchange for "fully predictable output" and "compile-time error reporting".
  The AI only needs to remember this one rule.
- **`server()`'s closure won't follow it to the server** — deliberately makes cross-environment dependencies explicit.
- **No `.value` / `.get()`** — `s()` is one read syntax, one fewer choice means one fewer class of errors.

---

## Testing & Quality

```bash
pnpm test              # build + 19 kernel + 245 unit
pnpm run coverage      # coverage (c8); fails below threshold
pnpm run test:browser  # 23 items: real Chromium running the whole app end-to-end (build examples first)
```

Layered:

- `test/run.mjs` (19 items): reactivity kernel / lists / scope reclamation / routing / RPC / SSR / XSS integration verification.
- `test/*.test.mjs` (245 items, `node:test`):
  `lint` rules and auto-fix (incl. deep-path in-place / parameter destructuring / effect hygiene no false positives),
  `errors` unified error code catalog (uniqueness / lint-produced codes all in table / old and new suppression names both hit),
  `schema` contract extraction, `compiler` error fallback and sourcemap,
  `cli` subcommands (incl. `agent-context` / `mcp` wire layer), `vite` plugin's compile / strip / contract-check interception /
  multi-entry manifest conflict,
  `server` (static hosting / path traversal / RPC / one-line serve),
  `testing` (`plain/testing`'s own unit + real TSX compile end-to-end),
  `keyed` list reuse semantics, `PLAIN_E1005` / `PLAIN_E1006` / `PLAIN_E1007` (argument and return) diagnosis and no false positives,
  `ref` imperative escape hatch (compile positive/negative examples + connect / cleanup / list / condition / SSR skip / hydration),
  `context` cross-layer values (default / nested shadow / sibling isolation / reactivity / effect path / reclamation / SSR isolation / hydration),
  `lsp` subcommand (Content-Length framing / diagnostic round-trip / unknown method),
  `types` (pin JSX type tightening with real `tsc`: misspelled attribute / wrong type must error, valid writing must not),
  `schema`'s props declaration (type alias / inline literal / `extends` and `&` merge / unresolvable labeled honestly),
  HMR (mount-point precise replacement / non-mount module re-run fallback / explicit warning when root component unrecognizable / capability boundary:
  outside-range preserved, inside-range rebuilt),
  `ssr-data` (SSR data full chain: server direct call / wait-for-settle / concurrency isolation / payload migration and hydration pairing /
  `ssrMiddleware` placeholders and escaping),
  async resource lifecycle and context getter (`PLAIN_E1113` / `PLAIN_E1114`),
  `eval` context positioning, SSR serialization, runtime boundary branches.
- `test/browser.mjs` (23 items): real Chromium end-to-end, covering check / uncheck, add, filter, delete,
  route jump, detail params, `server()` round-trip, 404, ErrorBoundary downgrade and retry, and **zero console errors**.

Several items are **regression tests**, specifically watching historically verified fatal bugs:

- "UI doesn't update after checking a todo" — row-level reactivity (`rowProxy`) regression point
- "Effects leak after switching branches / deleting rows" — owner scope reclamation regression point
- "signal call missing in JSX attribute" — `autofix` range overlap would corrupt the source (`done()` → `done()()`) regression point
- "Multiple files each have a `server()`" — server manifest incremental update producing duplicate `const` declarations regression point
- "sourcemap off by one line" — a helper import line would shift all subsequent mappings by one line regression point

### Official test toolkit (`plain/testing`)

Plain's output is **pure DOM** (no virtual DOM), so testing a component is "mount it into a real container → click it → read the DOM it produced".
`plain/testing` bundles these into a zero-dependency API, **without pulling in @testing-library** (it relies on accessibility roles +
semantic queries, over-engineered for a framework that produces DOM directly).

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, fireEvent, expectText } from "plain/testing";
import { Counter } from "./Counter.js";

test("click once adds one", () => {
  const ui = render(Counter);            // mount into a fresh container, returns query/unmount API
  expectText(ui, "add0");                // failure message includes actual text + HTML
  fireEvent.click(ui.get("button"));     // signal write in event flushes synchronously
  expectText(ui, "add1");
  ui.unmount();                          // reclaim effects + remove container
});
```

`render()` returns `container` / `html()` / `text()` / `get()` / `query()` / `queryAll()` /
`getByText()` / `queryByText()` / `unmount()`; `fireEvent` covers `click` / `input(value)` /
`change(value)` / `submit` / `focus` / `blur` / `keyDown` / `keyUp` / `fire(type)`.
Since `signal.set` flushes synchronously, the DOM is already final after `fireEvent` — **no await needed**;
for async data (`resource`) use `await flush()` to wait for the microtask.

The test environment needs a DOM first (recommend `jsdom`). `render()` throws a **helpful install guide** error when DOM is missing, not a bare
`document is not defined` to guess from.

### AI correctness eval (`eval/`)

"Plain is more AI-friendly than React" is currently just a **claim**. `eval/` turns it into comparable data, in two sets:

```bash
pnpm run eval              # Plain's own quality metrics (7 tasks)
pnpm run eval:compare      # Plain vs React symmetric comparison (3 cases, shared prompt and assertions)

node eval/run.mjs --prompt          # print task prompts, hand to an agent
node eval/compare/run.mjs --prompt  # print comparison case prompts
# both support --reference: run the reference implementation to self-check the harness (not counted as metrics)
```

- `eval/tasks/`: will the agent make these mistakes, and will the build intercept them. Aligned with `AGENTS.md`'s anti-pattern catalog.
- `eval/compare/`: **same prompt + same assertions**, framework differences all absorbed into the adapter;
  server-boundary tasks are not comparable and excluded with reasons.

Metric definitions are **first-pass rate / average iteration rounds / interception rate** (how much of the failures were caught at build time),
not satisfaction or onboarding time. Protocol and fairness requirements in [`eval/README.md`](eval/README.md) and
[`eval/compare/README.md`](eval/compare/README.md), results in [`eval/RESULTS.md`](eval/RESULTS.md).

Coverage is measured by c8 and enforced by CI (config in `.c8rc.json`):

| Metric | Gate | Current |
| --- | --- | --- |
| Statements | 90% | 94.1% |
| Branches | 82% | 86.3% |
| Functions | 85% | 91.6% |
| Lines | 90% | 94.1% |

> The least-covered is `src/cli/index.ts` (~77%): `dev` / `build` / `serve` three subcommands need to actually start vite,
> currently only indirectly verified in the example end-to-end (`src/cli` directory overall ~87%).

```bash
$ pnpm test
passed 19 / 19          # kernel
# pass 245 / fail 0     # unit

$ pnpm run test:browser
passed 23 / 23
```

---

## Examples

Full examples in [`examples/todo/`](examples/todo/): todo list + detail route + stats page (server data) + error boundary, covering all core capabilities.

Also [`examples/data-table/`](examples/data-table/): 50k rows of **windowing (virtual list) + column sorting + search**, showing fine-grained updates of signals under large data with constant DOM node count.

> ⚠️ Neither example has its own `package.json`; they depend on **the framework being built to `dist/` first**.
> Install deps and build the framework before starting, otherwise `dist/cli/index.js` etc. don't exist.

```bash
# 1. install deps (only typescript + vite needed)
pnpm install

# 2. build framework source to dist/
pnpm run build

# 3. start example (recommended: via examples/todo/vite.config.js, port 8100)
pnpm run dev:example
#    open http://localhost:8100/

# 3'. or use the official CLI (plaindev); note it doesn't read vite.config.js, port is vite default 5173
node dist/cli/index.js dev examples/todo
#    open http://localhost:5173/
```

The difference between the two commands:

| Command | Port | Reads `examples/todo/vite.config.js`? | Note |
| --- | --- | --- | --- |
| `pnpm run dev:example` | 8100 | Yes (with `serverEntry` / `root` config) | matches the example config exactly, recommended |
| `node dist/cli/index.js dev examples/todo` | 5173 | No (`configFile: false`, default plugin config) | for experiencing the plaindev CLI itself |

> After changing framework source, rebuild (`pnpm run build`) and refresh (the framework's own source build; example component changes
> go through HMR in dev, no full refresh needed).

### Creating a new project from scratch: create-plain

Don't want to start from an example? Use the official scaffolder to initialize in one step:

```bash
npx create-plain my-app
cd my-app && npm install && npm run dev
```

The scaffolder source is in [`packages/create-plain/`](packages/create-plain); it only copies the built-in `minimal` template and replaces the project name, **no network, no auto-install, no auto git init**.

> When the framework is not yet published to npm, the `plain` dependency generated by the scaffolder can't be installed directly.
> See [`packages/create-plain/README.md`](packages/create-plain/README.md) "Local development" section for the local access method
> (use `link:` to point at the local framework directory).

---

## Directory Structure

```
src/
  runtime/
    signal.ts     reactivity kernel: signal / computed / effect / batch / scope reclamation / rowProxy
    dom.ts        build DOM: insert / when / each (index or keyed reuse) / Slot anchor / minimal reflow
    async.ts     resource (race-safe) / rpc / server
    router.ts    routing (history / hash / :param / *)
    error.ts     ErrorBoundary
    index.ts     the only public entry
  compiler/
    index.ts     TSX -> DOM-building code (TS parse + source slicing + output self-check)
    manifest.ts  server manifest generation (dev incremental / build full)
    schema.ts    component contract extraction
  vite/index.ts  Vite plugin (type strip -> compile -> server strip -> RPC middleware)
  server/
    index.ts     rpcMiddleware / staticMiddleware / serve
    render.ts    renderToString (SSR)
    dom-shim.ts  zero-dependency server DOM
  cli/index.ts   plaindev
  lint.ts        contract check and auto-fix
  index.ts       aggregated exports (produces dist/index.d.ts as the package type entry)
types/           historical hand-written .d.ts removed; types auto-produced by tsc to dist/
test/
  run.mjs                   kernel/integration verification (must run)
  *.test.mjs                unit tests (node:test, run by pnpm test:unit)
  browser.mjs               real browser end-to-end (manually triggered)
.c8rc.json                  coverage threshold config
.github/workflows/ci.yml    build + unit + coverage gate
AGENTS.md                   working instructions for AI agents + anti-pattern catalog
ROADMAP.md                  staged plan and acceptance criteria
CHANGELOG.md                changelog
CONTRIBUTING.md             contribution and commit conventions (Conventional Commits)
eval/                      AI correctness eval: tasks + acceptance assertions + metrics
```

---

## License

This project is licensed under the **MIT License** (see the `LICENSE` file in the repo root):

- **Free for commercial use**: freely use, copy, modify, merge, publish, distribute, relicense and sell, including integrating into commercial products/services.
- **Only requirement**: retain the copyright notice and the full license text.
- Copyright and attribution belong to the author **benoly520**.

For enterprise support or commercial cooperation, contact the author (GitHub: [@benoly520](https://github.com/benoly520)) — this is an **optional value-add**,
not a prerequisite for use.
