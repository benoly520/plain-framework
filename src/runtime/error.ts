// Plain 错误边界：把子树里的运行时错误就地降级成 fallback UI，而不是整页白屏

import type { Slot, Renderable } from "../types.js";
import { ERROR_HANDLER, withOwner } from "./signal.js";
import { createSlot } from "./dom.js";

/**
 * <ErrorBoundary fallback={(e, retry) => <div>...</div>}>...</ErrorBoundary>
 * children 或其子树里任意 effect 抛错，都会落到 fallback。
 */
export function ErrorBoundary(props: {
  fallback?: (err: Error, retry: () => void) => Renderable;
  // 编译器会把 JSX children 自动包成 thunk，运行时恒为 () => Renderable；
  // 这里用 any 与旧公开类型保持一致，避免约束 JSX 直接子树。
  children?: any;
}): Slot {
  const slot = createSlot("eb");

  // 在一个全新的 owner 里重建子树；出错时这个 owner 会被整体回收
  const rebuild = (build: () => Renderable | null) => {
    slot.clear();
    const cleanups = new Set<() => void>();
    (cleanups as any)[ERROR_HANDLER] = handler;
    withOwner(cleanups, () => {
      const node = build();
      if (node) slot.set(node);
    });
  };

  const handler = (err: unknown) =>
    rebuild(() =>
      props.fallback
        ? props.fallback(err as Error, retry)
        : fallbackDefault(err as Error)
    );

  const retry = () => rebuild(() => (props.children ? props.children() : null));

  rebuild(() => (props.children ? props.children() : null));
  return slot;
}

function fallbackDefault(err: unknown): Node {
  const box = document.createElement("div");
  box.className = "plain-error";
  const title = document.createElement("strong");
  title.appendChild(document.createTextNode("渲染出错："));
  const msg = document.createTextNode(String((err as any) && (err as any).message || err));
  box.appendChild(title);
  box.appendChild(msg);
  return box;
}
