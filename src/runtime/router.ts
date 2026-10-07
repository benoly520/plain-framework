// Plain 路由：history / hash 两种模式，支持 :param，路由切换自动回收上一页 effect

import type { Router, Route, RouteProps, Renderable, Owner } from "../types.js";
import { signal, computed, withOwner } from "./signal.js";
import { resolve, nodesOf } from "./dom.js";

function currentPath(mode: string): string {
  if (typeof window === "undefined") return "/";
  if (mode === "hash") return window.location.hash.slice(1) || "/";
  return window.location.pathname || "/";
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
  const path = signal(currentPath(mode));

  if (typeof window !== "undefined") {
    window.addEventListener(mode === "hash" ? "hashchange" : "popstate", () =>
      path.set(currentPath(mode))
    );
  }

  const matched = computed(() => {
    const p = path();
    for (const r of routes) {
      const params = match(r.path, p);
      if (params) return { route: r, params, path: p };
    }
    const fallback = routes.find((r) => r.path === "*");
    return { route: fallback || null, params: {}, path: p };
  });

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
