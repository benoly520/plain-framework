// Plain 路由：history / hash 两种模式，支持 :param，路由切换自动回收上一页 effect

import type { Router, Route, RouteProps, Renderable, Owner } from "../types.js";
import { signal, computed, withOwner } from "./signal.js";
import { resolve, nodesOf } from "./dom.js";
import { flushRefs } from "./ref.js";
import { getSSRStore } from "./ssr-context.js";

/**
 * 「当前路径」。
 * 服务端没有 `window` —— 那时用**本次请求的 URL**（`ssrMiddleware` 注入到渲染上下文里），
 * 否则 SSR 永远只渲染 `/`，多路由的 SEO 就白做了。
 */
function currentPath(mode: string, ssrUrl?: string | null): string {
  if (typeof window === "undefined") return ssrUrl || "/";
  if (mode === "hash") return window.location.hash.slice(1) || "/";
  return window.location.pathname || "/";
}

/** 服务端：取本次请求的 URL（不在渲染上下文里则为 null） */
function ssrUrl(): string | null {
  return (getSSRStore()?.url as string | null | undefined) ?? null;
}

function match(pattern: string, path: string): Record<string, string> | null {
  if (pattern === "*") return {};
  const ps = pattern.split("/").filter(Boolean);
  const xs = path.split("/").filter(Boolean);
  if (ps.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) {
      params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    } else if (ps[i] !== "*" && ps[i] !== xs[i]) {
      return null;
    }
  }
  return params;
}

/**
 * createRouter({ routes, mode })
 * routes: [{ path: '/', component: Home }, { path: '/todo/:id', component: Detail }, { path: '*', component: NotFound }]
 */
export function createRouter(options: {
  routes?: Route[];
  mode?: "history" | "hash";
}): Router {
  const { routes = [], mode = "history" } = options || {};
  const isServer = typeof window === "undefined";
  // 服务端：`createRouter` 在**任何一次渲染之前**就求值了（模块顶层），那时还没有请求上下文，
  // 所以先留空；真正解析放到每次读的时候（读一定发生在某次渲染里）——
  // 于是同一个 router 实例能被不同请求复用，各自解析出各自的 URL。
  const inner = signal(isServer ? "" : currentPath(mode));

  if (!isServer) {
    window.addEventListener(mode === "hash" ? "hashchange" : "popstate", () =>
      inner.set(currentPath(mode))
    );
  }

  // 对外仍是 `Signal<string>` 的形状（可调用 / peek / set / subs），只是读的时候顺带解析。
  // 这样 set() 语义不变（用户强制改路径依然可行），也不必改公开类型。
  const path = Object.assign(
    () => inner() || currentPath(mode, ssrUrl()),
    {
      peek: () => inner.peek() || currentPath(mode, ssrUrl()),
      set: (v: string) => inner.set(v),
      subs: inner.subs,
    }
  ) as unknown as typeof inner;

  /**
   * ⚠️ 这里**刻意不用 computed**：computed 会缓存，而服务端的路径来自
   * **每次渲染的上下文**（非响应式）—— 缓存会让第二个请求复用第一个请求的匹配结果。
   * route 匹配本身很便宜，直接算；响应式不受影响（读 `path()` 仍会订阅，只是发生在调用方的作用域里）。
   */
  const matched = () => {
    const p = path();
    for (const r of routes) {
      const params = match(r.path, p);
      if (params) return { route: r, params, path: p };
    }
    const fallback = routes.find((r) => r.path === "*");
    return { route: fallback || null, params: {}, path: p };
  };

  function navigate(to: string, replace?: boolean): void {
    if (typeof window === "undefined") return;
    if (mode === "hash") {
      window.location.hash = to;
    } else if (replace) {
      window.history.replaceState({}, "", to);
      path.set(currentPath(mode));
    } else {
      window.history.pushState({}, "", to);
      path.set(currentPath(mode));
    }
  }

  function Link(props: {
    to: string | (() => string);
    children?: () => Renderable;
  }): Node {
    const to = () => String(resolve(props.to));
    const el = document.createElement("a");
    el.setAttribute("href", to());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(to());
    });
    const kids = props.children ? props.children() : null;
    if (kids) nodesOf(kids).forEach((n: Node) => el.appendChild(n));
    return el;
  }

  return {
    path,
    current: matched,
    params: () => matched().params,
    route: () => matched().route,
    navigate,
    Link,
    /**
     * render(container) —— 返回一个 update 函数，路由变化时重绘并回收上一页
     */
    render(container: Node) {
      let current: any = null;
      return () => {
        const m = matched();
        if (current) {
          current.dispose();
          current.nodes.forEach((n: any) => n.remove && n.remove());
          current = null;
        }
        if (!m.route || !m.route.component) return;
        const cleanups = new Set<() => void>();
        let node: any = null;
        withOwner(cleanups, () => {
          node = m.route!.component({ params: m.params, path: m.path } as RouteProps);
        });
        const nodes = nodesOf(node);
        nodes.forEach((n: Node) => container.appendChild(n));
        // 路由页刚接入文档 -> 跑掉这一页的 ref 回调（见 ref.ts）
        flushRefs();
        current = {
          nodes,
          dispose() {
            cleanups.forEach((f) => f());
            cleanups.clear();
          },
        };
      };
    },
  };
}
