// Plain 错误边界：把子树里的运行时错误就地降级成 fallback UI，而不是整页白屏

import { ERROR_HANDLER, withOwner } from "./signal.js";
import { createSlot, toNodes } from "./dom.js";

/**
 * <ErrorBoundary fallback={(e, retry) => <div>...</div>}>...</ErrorBoundary>
 * children 或其子树里任意 effect 抛错，都会落到 fallback。
 */
export function ErrorBoundary(props) {
  const slot = createSlot("eb");

  // 在一个全新的 owner 里重建子树；出错时这个 owner 会被整体回收
  const rebuild = (build) => {
    slot.clear();
    const cleanups = new Set();
    cleanups[ERROR_HANDLER] = handler;
    withOwner(cleanups, () => {
      const node = build();
      if (node) slot.set(node);
    });
  };

  const handler = (err) =>
    rebuild(() =>
      props.fallback ? props.fallback(err, retry) : fallbackDefault(err)
    );

  const retry = () => rebuild(() => (props.children ? props.children() : null));

  rebuild(() => (props.children ? props.children() : null));
  return slot;
}

function fallbackDefault(err) {
  const box = document.createElement("div");
  box.className = "plain-error";
  const title = document.createElement("strong");
  title.appendChild(document.createTextNode("渲染出错："));
  const msg = document.createTextNode(String((err && err.message) || err));
  box.appendChild(title);
  box.appendChild(msg);
  return box;
}
