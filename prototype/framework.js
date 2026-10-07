// ============================================================================
// Plain —— 一个面向 AI 的迷你前端框架（原型 / 运行时版）
// ----------------------------------------------------------------------------
// 设计原则（按对 AI 的重要性排序）：
//   1. Locality     读代码即可推出行为：无 hook 顺序、无 deps 数组、无 Proxy 魔法
//   2. 唯一状态原语  signal / computed / effect，没有 20 种变体
//   3. 单文件单语言  逻辑与 markup 同作用域（hyperscript 风格，无模板/逻辑分离）
//   4. 显式执行边界  server() 一个关键字声明代码在哪端跑（编译期可剥离）
//   5. 编译到 DOM    （运行时版用细粒度绑定模拟；编译版直接出 DOM 操作）
//   6. 稳定小核心    ~10 个导出，API 长期冻结
//   7. 类型即校验    immutable 更新，非法状态难以表达
//   8. AI 原生       机器可读、错误自解释（后续接 lint）
//
// 运行时版刻意不用深代理（deep proxy），状态更新走 immutable。
// 这比 Svelte 的深代理对 AI 更可预测：没有“原地改了但忘了触发”的陷阱。
// ============================================================================

// ---- 响应式内核：auto-tracking signals --------------------------------------

let activeEffect = null;
const effectStack = [];

function cleanup(effect) {
  effect.deps.forEach(function (signal) {
    signal.subs.delete(effect);
  });
  effect.deps.clear();
}

function effect(fn) {
  const e = {
    deps: new Set(),
    run: function () {
      cleanup(e);
      activeEffect = e;
      effectStack.push(e);
      try {
        return fn();
      } finally {
        effectStack.pop();
        activeEffect = effectStack[effectStack.length - 1] || null;
      }
    },
  };
  e.run();
  return e;
}

// signal: 唯一状态原语。读取 signal() ，写入 signal.set(x) 或 signal(x)。
// 读取发生在 effect 内会自动建立依赖，无需 deps 数组。
function signal(initial) {
  const s = { value: initial, subs: new Set() };
  const read = function () {
    if (activeEffect) {
      s.subs.add(activeEffect);
      activeEffect.deps.add(s);
    }
    return s.value;
  };
  read.set = function (next) {
    if (Object.is(next, s.value)) return next;
    s.value = next;
    // 复制一份再触发，避免 effect 内继续订阅导致无限循环
    Array.from(s.subs).forEach(function (sub) {
      sub.run();
    });
    return next;
  };
  return read;
}

// computed: 派生值。内部就是一个 effect 把结果写回一个 signal。
function computed(fn) {
  const out = signal(undefined);
  effect(function () {
    out.set(fn());
  });
  return out;
}

// ---- 视图层：hyperscript + 细粒度绑定 --------------------------------------

const Z = String.fromCharCode(0); // 占位符，几乎不可能出现在用户内容里
const TOKEN = function (i) {
  return Z + i + Z;
};

function isReactive(v) {
  return typeof v === "function" && v.subs !== undefined;
}

function resolveVal(v) {
  if (isReactive(v)) return v();
  if (typeof v === "function") return v();
  return v;
}

function stringify(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

const BOOL_ATTRS = new Set([
  "checked",
  "disabled",
  "selected",
  "readonly",
  "required",
  "hidden",
]);

// 把视图里的动态部分（token）替换成真实节点 / 响应式绑定
function bind(root, values) {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
  );
  const textNodes = [];
  const elements = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 3) textNodes.push(n);
    else elements.push(n);
  }

  const tokenRe = new RegExp(Z + "(\\d+)" + Z, "g");

  // 文本节点
  textNodes.forEach(function (t) {
    if (t.nodeValue.indexOf(Z) === -1) return;
    const parts = t.nodeValue.split(tokenRe);
    const parent = t.parentNode;
    const frag = document.createDocumentFragment();
    parts.forEach(function (p) {
      if (p === "") return;
      if (/^\d+$/.test(p)) {
        const v = values[Number(p)];
        if (v instanceof Node) {
          frag.appendChild(v);
        } else {
          const tn = document.createTextNode("");
          frag.appendChild(tn);
          effect(function () {
            tn.nodeValue = stringify(resolveVal(v));
          });
        }
      } else {
        frag.appendChild(document.createTextNode(p));
      }
    });
    parent.replaceChild(frag, t);
  });

  // 元素属性
  elements.forEach(function (el) {
    Array.from(el.attributes).forEach(function (attr) {
      const val = attr.value;
      if (typeof val !== "string" || val.indexOf(Z) === -1) return;
      const name = attr.name;
      el.removeAttribute(name);

      if (name.indexOf("on") === 0 && name.length > 2) {
        // 事件处理器
        const m = val.match(tokenRe);
        const idx = m ? Number(m[1]) : null;
        const handler = idx !== null ? values[idx] : null;
        if (typeof handler === "function") {
          el.addEventListener(name.slice(2).toLowerCase(), handler);
        }
        return;
      }

      if (BOOL_ATTRS.has(name)) {
        const m = val.match(tokenRe);
        const idx = m ? Number(m[1]) : null;
        effect(function () {
          const b = !!resolveVal(values[idx]);
          el[name] = b;
          if (b) el.setAttribute(name, "");
          else el.removeAttribute(name);
        });
        return;
      }

      // 普通响应式属性（可能混合多个 token）
      effect(function () {
        const resolved = val
          .split(tokenRe)
          .map(function (p) {
            return /^\d+$/.test(p) ? stringify(resolveVal(values[Number(p)])) : p;
          })
          .join("");
        if (name === "class") el.className = resolved;
        else el.setAttribute(name, resolved);
      });
    });
  });
}

// html: 单文件单语言的视图构造器。${signal} 即细粒度绑定。
function html(strings) {
  const values = Array.prototype.slice.call(arguments, 1);
  let str = strings[0];
  for (let i = 0; i < values.length; i++) {
    str += TOKEN(i) + strings[i + 1];
  }
  const tpl = document.createElement("template");
  tpl.innerHTML = str;
  bind(tpl.content, values);
  return tpl.content;
}

// ---- 控制流：用普通函数，不引入新的模板 DSL --------------------------------

// 条件渲染：cond 是读取 signal 的函数，自动追踪。
function when(cond, thenFn, elseFn) {
  const frag = document.createDocumentFragment();
  effect(function () {
    const branch = cond() ? thenFn() : elseFn ? elseFn() : null;
    frag.replaceChildren.apply(
      frag,
      branch ? Array.from(branch.childNodes) : []
    );
  });
  return frag;
}

// 列表渲染：keyed，按 key 复用节点（未变项不重建，细粒度）。
function each(items, keyFn, itemFn) {
  const frag = document.createDocumentFragment();
  let map = new Map();
  effect(function () {
    const arr = items();
    const next = new Map();
    const builder = document.createDocumentFragment();
    arr.forEach(function (item) {
      const k = keyFn(item);
      if (map.has(k)) {
        next.set(k, map.get(k));
        builder.appendChild(map.get(k));
        map.delete(k);
      } else {
        const node = itemFn(item);
        next.set(k, node);
        builder.appendChild(node);
      }
    });
    map.forEach(function (node) {
      node.remove();
    });
    map = next;
    frag.replaceChildren.apply(frag, Array.from(builder.childNodes));
  });
  return frag;
}

// ---- 异步：resource 对应“服务端取数”，天然带 loading ------------------------

function resource(promiseFn) {
  const data = signal(undefined);
  const loading = signal(true);
  effect(function () {
    loading.set(true);
    promiseFn().then(function (v) {
      data.set(v);
      loading.set(false);
    });
  });
  return { data: data, loading: loading };
}

// ---- 显式执行边界 ----------------------------------------------------------

// server(): 标记该函数只能在服务端运行。运行时版直接透传；
// 编译版会把它从客户端 bundle 剥离，并在调用处生成 RPC 桩。
function server(fn) {
  fn.__server = true;
  return fn;
}

// ---- 挂载 ------------------------------------------------------------------

function mount(target, node) {
  target.appendChild(node);
}

export {
  signal,
  computed,
  effect,
  html,
  when,
  each,
  resource,
  server,
  mount,
};
