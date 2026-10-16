// 属性「输入拼写 -> 落地方式」的**唯一**归一化表。
//
// 为什么单独成模块：
// 同一语义此前分散在两处各写各的 —— 静态字面量分支只特判了 className，其余一律
// `setAttribute(用户原样拼写)`；动态表达式分支走 PROP_ALIAS / DOM_PROPS 另一套。
// 结果是 `<label htmlFor="x">` 静态产物落到属性 "htmlFor"（浏览器会把 HTML 属性名
// 小写成 `htmlfor`，不是 `<label>` 认的 `for`），而动态产物落到 `.htmlFor` ——
// 两条路**静默分叉**，正是本框架最想消灭的失败模式。
//
// 现在两条路径都必须经过本模块：只允许「值从哪来」不同（字面量 / 表达式），
// 不允许「落到哪个属性」不同。命名空间判定也只在这里做一次。
//
// 无任何依赖，编译器（Node 侧）与运行时 / SSR 垫片共用。

export const SVG_NS = "http://www.w3.org/2000/svg";
export const MATH_NS = "http://www.w3.org/1998/Math/MathML";

/**
 * 这些标签名只可能是 SVG / MathML 元素，绝不会是 HTML 元素；
 * 因此可以直接按命名空间创建，无需依赖「创建时的父节点上下文」。
 *
 * 为什么需要它：uni-ui 的图标用 <Svg> 组件包裹，真实的 <polyline>/<circle>
 * 是作为 children 在「外层组件作用域」里先创建、再 place 进 <svg> 的 —— 创建时
 * 它的直接父是 fragment（HTML 上下文），按父节点推断会建成 HTML 元素，塞进 svg
 * 后也改不了命名空间，于是图标不渲染。按标签名直接给命名空间即可根治。
 * （刻意排除 a / title 等 HTML/SVG 同名歧义标签，它们走下面的父节点推断。）
 */
export const SVG_TAGS = new Set<string>([
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline",
  "polygon", "text", "tspan", "defs", "use", "symbol", "linearGradient",
  "radialGradient", "stop", "clipPath", "image", "marker", "pattern", "mask",
  "filter", "feGaussianBlur", "feOffset", "feMerge", "feMergeNode",
  "feColorMatrix", "feBlend", "feComposite", "metadata", "switch", "view", "desc",
]);

export const MATH_TAGS = new Set<string>([
  "math", "mi", "mn", "mo", "ms", "mtext", "mspace", "mrow", "mfrac", "msqrt",
  "mroot", "msup", "msub", "msubsup", "mover", "munder", "mmultiscripts",
  "mtable", "mtr", "mtd", "mlabeledtr",
]);

/**
 * 按标签名判命名空间。
 * @returns SVG / MathML 命名空间；判不出来（含 a / title 等歧义标签）返回 null，按 HTML 处理。
 */
export function nsForTag(tag: string): string | null {
  if (SVG_TAGS.has(tag)) return SVG_NS;
  if (MATH_TAGS.has(tag)) return MATH_NS;
  return null;
}

// ---------------------------------------------------------------------------
// 兼容输入拼写 -> 规范属性名
//
// 方言政策（对应 SPEC §4）：
// - **规范拼写 = 原生 HTML 名**（`class` / `for`）—— 产物里只会出现它；
// - camelCase 的 DOM 名只作为**兼容输入**接受，归一到同一个属性。收它们**不是**为了
//   「兼容 React API」，而是因为 AI / 存量代码的训练分布里 React 写法占绝对多数：
//   收下来的成本是一张表，收益是首次写对率（`eval/` 的 first-pass rate）。
//   代价是方言多一种，所以**必须集中登记、且只有一个规范名**。
// - 不在这里登记的 camelCase（`colSpan` / `tabIndex` / `maxLength`…）靠「HTML 一律小写」
//   成立 —— 那是 DOM property 名，不是 React 遗产，别混进来。
// ---------------------------------------------------------------------------

/**
 * **React 拼写 -> 规范属性名**。
 *
 * 这就是全部的 React 兼容面：只有 `class` / `for` 这两个属性的 React 拼写与 HTML 属性名
 * 不同，因此只有这两个需要登记。**扩大它是一次显式决定** —— 要同步改
 * `test/attrs.test.mjs` 里钉住的那份清单，而不是顺手加一行。
 */
export const REACT_COMPAT_ALIASES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
};

/**
 * HTML **自身带连字符**的属性 -> 规范名（单纯小写化会丢掉连字符，必须显式登记）。
 * 与 React 无关。
 */
export const HTML_HYPHEN_ALIASES: Record<string, string> = {
  acceptCharset: "accept-charset",
  acceptcharset: "accept-charset",
  httpEquiv: "http-equiv",
  httpequiv: "http-equiv",
};

/** 查表用：两张兼容表合并。分开放只为让「哪些是 React 遗产」一眼可见。 */
const ATTR_ALIASES: Record<string, string> = {
  ...REACT_COMPAT_ALIASES,
  ...HTML_HYPHEN_ALIASES,
};

/**
 * 规范属性名 —— 静态与动态两条路径**都必须**用它，这是「不再分叉」的保证。
 *
 * - SVG / MathML：属性名大小写敏感（`viewBox` / `preserveAspectRatio` / `linearGradient`），
 *   必须原样保留，否则属性直接失效；
 * - HTML：浏览器本来就会把属性名小写化，这里提前小写，让产物、SSR 输出、
 *   浏览器解析结果三者完全一致（hydrate 的属性对比依赖这一点）。
 */
export function canonicalAttrName(raw: string, tag?: string): string {
  const aliased = ATTR_ALIASES[raw] ?? raw;
  // 命名空间敏感：TSX 里写的是 viewBox 就必须是 viewBox
  if (tag && nsForTag(tag)) return aliased;
  return aliased.toLowerCase();
}

/** property 落地定义：`bool` 为真表示这是「存在即生效」的布尔属性 */
export interface ReflectedProp {
  /** DOM property 名（如 className / htmlFor / readOnly） */
  prop: string;
  /** 布尔属性：只有「在 / 不在」两种语义，不走字符串转换 */
  bool?: boolean;
}

/**
 * 规范属性名 -> 走 property 赋值的项（仅 HTML 元素）。
 *
 * 为什么动态更新要走 property：`setAttribute` 改不动「已经脏了」的表单状态
 * （用户输入过的 `<input>`，设 `value` 属性不会改变当前值），必须赋 property。
 * 服务端垫片会把这里的每个 property 反射回 `attributes`，SSR 序列化才不会丢
 * （见 src/server/dom-shim.ts）。
 */
export const REFLECTED_ATTRS: Record<string, ReflectedProp> = {
  class: { prop: "className" },
  for: { prop: "htmlFor" },
  value: { prop: "value" },
  id: { prop: "id" },
  type: { prop: "type" },
  name: { prop: "name" },
  href: { prop: "href" },
  src: { prop: "src" },
  alt: { prop: "alt" },
  title: { prop: "title" },
  placeholder: { prop: "placeholder" },
  pattern: { prop: "pattern" },
  min: { prop: "min" },
  max: { prop: "max" },
  step: { prop: "step" },
  maxlength: { prop: "maxLength" },
  tabindex: { prop: "tabIndex" },
  readonly: { prop: "readOnly", bool: true },
  checked: { prop: "checked", bool: true },
  selected: { prop: "selected", bool: true },
  disabled: { prop: "disabled", bool: true },
  multiple: { prop: "multiple", bool: true },
};

/** 属性落地方式：赋 DOM property，还是 setAttribute（命名空间敏感，保留大小写） */
export type AttrOp = { kind: "prop"; prop: string } | { kind: "attr"; name: string };

/**
 * 解析一个属性该落到哪里。**静态与动态都必须经过它**（静态只用 name 部分）。
 *
 * - SVG / MathML 一律 `setAttribute` 原样名：SVG 的 `className` 是**只读**的
 *   `SVGAnimatedString`，赋值在严格模式下会抛错，所以不能走 property；
 * - HTML：`REFLECTED_ATTRS` 里能走 property 的走 property，其余 `setAttribute` 规范名。
 */
export function resolveAttr(raw: string, tag?: string): AttrOp {
  const name = canonicalAttrName(raw, tag);
  if (tag && nsForTag(tag)) return { kind: "attr", name };
  const reflected = REFLECTED_ATTRS[name];
  if (reflected) return { kind: "prop", prop: reflected.prop };
  return { kind: "attr", name };
}
