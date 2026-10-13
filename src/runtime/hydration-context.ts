// Plain hydration 上下文（零依赖）
//
// hydrate 的机制与 SSR 同源：SSR 靠「换掉 globalThis.document」让同一份编译产物
// 在 Node 里跑；hydrate 靠「换掉 globalThis.document」让同一份产物在浏览器里
// **认领**服务端已渲染好的真实节点，而不是新建。
//
// 本模块只维护「认领游标」这一件状态，不依赖 dom.ts / signal.ts，
// 从而避免 dom.ts <-> hydrate.ts 的循环依赖。
//
// 游标模型：**深度优先 DOM 遍历**，与 SSR 的文档顺序严格一致。
//   - 认领元素后，游标下降到该元素的第一个子节点（其子节点继续按序被认领）；
//   - 认领文本/注释后，游标前进到下一个兄弟；同层耗尽则向上回退找下一个有兄弟的祖先。
//   - 认领的节点会被「摘除」返回，交由调用方重新挂载（节点对象身份不变）。
//
// 「锚点对」特例：insert / when / each / slot 用一对注释锚点界定动态区间。
// 编译产物先创建 start 锚点、再创建 end 锚点，但区间内的内容由运行时在两者之间
// 填充。为此提供 claimPair(openLabel, closeLabel)：认领 start、把两者之间的全部
// 现有节点作为 content 取出、再认领 end —— 这样 syncRange 拿到的是同一批节点。

/** 认领锚点前缀（必须与 server/dom-shim.ts 的 CLAIM_PREFIX、dom.ts 的 A 一致） */
export const CLAIM_PREFIX = "plain-";

export interface HydrationWarning {
  kind: "mismatch" | "extra" | "unclaimed";
  message: string;
}

interface HydrationCtx {
  root: Node;
  /**
   * 服务端节点的「文档顺序扁平快照」（深度优先，元素只入列自身、其子节点紧随）。
   * 认领游标 = 该列表的下标。之所以用扁平列表而非 live DOM 的 nextSibling 遍历：
   *   1) 编译产物会边认领边 `appendChild` 重挂节点，live DOM 的兄弟链接会被打乱；
   *   2) 认领成功时节点保持原位，但如果宿主改动了服务端 DOM，扁平快照仍与
   *      「SSR 产出顺序」严格一致，认领结果稳定可预期。
   */
  list: Node[];
  /** 当前游标（下一个待认领节点在 list 中的下标） */
  index: number;
  warnings: HydrationWarning[];
  recover: boolean;
}

let ctx: HydrationCtx | null = null;

/** 深度优先收集 root 子树里的全部节点（元素与文本/注释都入列），即文档顺序 */
function flatten(root: Node): Node[] {
  const out: Node[] = [];
  const walk = (n: any) => {
    out.push(n);
    let c = n.firstChild;
    while (c) {
      walk(c);
      c = c.nextSibling;
    }
  };
  let c = root.firstChild;
  while (c) {
    walk(c);
    c = c.nextSibling;
  }
  return out;
}

export function beginHydrate(
  root: Node,
  options: { recover?: boolean } = {}
): HydrationCtx {
  const list = flatten(root);
  ctx = {
    root,
    list,
    index: 0,
    warnings: [],
    recover: options.recover !== false,
  };
  return ctx;
}

export function endHydrate(): HydrationWarning[] {
  const c = ctx;
  ctx = null;
  return c ? c.warnings : [];
}

export function getHydrationCtx(): HydrationCtx | null {
  return ctx;
}

export function isHydrating(): boolean {
  return ctx !== null;
}

/**
 * 临时挂起认领（返回恢复函数）。
 * 用于 insert/when/each：锚点对已认领后，其「内部新内容」应由运行时正常新建，
 * 再经 syncRange 与已认领的服务端内容做对齐复用 —— 若内部内容也走认领，
 * 会与已被 claimPair 取走的内容重复消费游标。
 */
export function suspendHydrate(): () => void {
  const saved = ctx;
  ctx = null;
  return () => {
    ctx = saved;
  };
}

function warn(kind: HydrationWarning["kind"], message: string): void {
  if (ctx) ctx.warnings.push({ kind, message });
}

function detach(node: Node): void {
  const p: any = (node as any).parentNode;
  if (p) p.removeChild(node);
}

/** 描述一个节点，供告警信息使用 */
function describe(n: any): string {
  if (!n) return "EOF";
  if (n.nodeType === 1) return `<${n.tagName.toLowerCase()}>`;
  if (n.nodeType === 3) return `文本 "${n.nodeValue}"`;
  if (n.nodeType === 8) return `注释 <!--${n.nodeValue}-->`;
  return `节点(${n.nodeType})`;
}

/** 当前游标节点（不前进，不跳过空白） */
function peek(): Node | null {
  if (!ctx) return null;
  return ctx.index < ctx.list.length ? ctx.list[ctx.index] : null;
}

/** 游标前进一格 */
function step(): void {
  if (ctx) ctx.index++;
}

/** 跳过纯空白文本节点（SSR 可能夹带格式化空白） */
function skipWhitespace(): void {
  while (ctx) {
    const n: any = peek();
    if (n && n.nodeType === 3 && (n.nodeValue || "").trim() === "") {
      step();
      continue;
    }
    break;
  }
}

/**
 * 认领一个元素节点。
 * - 游标上是同名元素 → 复用（**节点身份不变**）
 * - 类型不符 → recover 时返回 null（调用方新建），否则复用游标节点
 * 无论认领成功与否，游标都会前进一格 —— 因为「编译产物接下来会 appendChild
 * 该节点（认领到的或新建的）」，其子节点将由后续 createX 认领（在扁平快照里
 * 紧跟其后）。
 */
export function claimElement(tag: string): any {
  if (!ctx) return null;
  skipWhitespace();
  const node: any = peek();
  if (node && node.nodeType === 1 && String(node.tagName).toLowerCase() === tag.toLowerCase()) {
    step();
    // 保持节点当前子节点不动；编译产物随后 appendChild(el) 会把 el 挂到正确父级，
    // el 的原有子节点仍在其中，后续 createX 会按扁平快照顺序认领它们。
    return node;
  }
  warn(
    "mismatch",
    `hydrate 期望 <${tag}>，服务端对应位置为 ${describe(node)} —— 已就地修正（新建该节点）`
  );
  if (node && ctx.recover) step();
  return null; // 交回调用方新建
}

/**
 * 认领一个文本节点；内容不同时**就地改 nodeValue**（不 remove+insert）。
 * 认领成功时把节点从原父级摘下返回：编译产物会把它 appendChild 回正确位置，
 * 从而与「新建」路径的顺序完全一致（首屏文本不错位）。
 */
export function claimText(value: string): any {
  if (!ctx) return null;
  skipWhitespace();
  const node: any = peek();
  if (node && node.nodeType === 3) {
    step();
    detach(node);
    if (node.nodeValue !== value) node.nodeValue = value; // 就地修正
    return node;
  }
  warn(
    "mismatch",
    `hydrate 期望文本 "${value}"，服务端对应位置为 ${describe(node)} —— 已就地修正（新建文本）`
  );
  if (node && ctx.recover) step();
  return null;
}

/**
 * 认领一个锚点注释（单点）。label 形如 "plain-["。
 * 与 claimText 同理：摘下返回，交由调用方 appendChild 归位。
 */
export function claimMarker(label: string): any {
  if (!ctx) return null;
  skipWhitespace();
  const node: any = peek();
  if (node && node.nodeType === 8 && node.nodeValue === label) {
    step();
    detach(node);
    return node;
  }
  return null; // 交回调用方新建
}

/**
 * 认领一对锚点，并把它俩之间的现有节点作为 content 取出（**从 DOM 摘下**）。
 * 供 insert / when / each / slot 使用：编译产物拿到 start/end 后会把它们
 * appendChild 回父级，内容由 syncRange 依据 content 复用 —— 全程节点身份不变。
 *
 * 返回 { start, end, content }；若锚点对不匹配则返回 null（调用方走新建路径）。
 */
export function claimPair(
  openLabel: string,
  closeLabel: string
): { start: any; end: any; content: any[] } | null {
  if (!ctx) return null;
  skipWhitespace();
  const start: any = peek();
  if (!(start && start.nodeType === 8 && start.nodeValue === openLabel)) return null;

  // 只在**同一父级的直接兄弟**里收集到 closeLabel 为止：区间内的嵌套结构
  // （如 each 里每行的 <li> 内部还有 insert 锚点）由其各自的 insert/when/each
  // 递归认领，不能在这里把它们也当作顶层 content 收走。
  const content: any[] = [];
  let close: any = null;
  let sib: any = start.nextSibling;
  while (sib) {
    if (sib.nodeType === 8 && sib.nodeValue === closeLabel) {
      close = sib;
      break;
    }
    content.push(sib);
    sib = sib.nextSibling;
  }
  if (!close) return null;

  // 游标（扁平快照下标）需要推进到 close 的「子树全部节点」之后。
  // 扁平快照是文档顺序，因此找到 close 在列表中的位置，并跳过其整棵子树。
  skipFlatTo(close);

  // 把锚点与内容从原父级摘下（保留对象引用），交由调用方重新挂载/对齐
  detach(start);
  content.forEach((c) => detach(c));
  detach(close);
  return { start, end: close, content };
}

/** 把扁平游标推进到「以 node 为根的子树」之后（即 node 的下一个文档序节点） */
function skipFlatTo(node: Node): void {
  if (!ctx) return;
  // 找到 node 当前所在下标（从当前 index 起找，保证单调前进）
  let i = ctx.index;
  while (i < ctx.list.length && ctx.list[i] !== node) i++;
  if (i >= ctx.list.length) return; // 不在快照中（异常），保持原游标
  // 跳过 node 及其后代：后代是紧随 node 的连续区间，直到遇到不再是 node 后代的节点
  let j = i + 1;
  while (j < ctx.list.length && isDescendant(ctx.list[j], node)) j++;
  ctx.index = j;
}

/** a 是否为 b 的后代（沿 parentNode 上溯） */
function isDescendant(a: Node, b: Node): boolean {
  let p: any = (a as any).parentNode;
  while (p) {
    if (p === b) return true;
    p = p.parentNode;
  }
  return false;
}

/**
 * hydrate 结束时检查是否还有未认领的服务端节点（多余 DOM → 告警）。
 */
export function assertConsumed(root: Node): void {
  if (!ctx) return;
  skipWhitespace();
  const rest = ctx.index < ctx.list.length ? ctx.list[ctx.index] : null;
  if (rest) {
    warn(
      "extra",
      `hydrate 完成后仍有未被认领的节点：${describe(rest)}（服务端多余内容，已保留）`
    );
  }
}
