// Plain 类型声明 —— 面向 AI 与 IDE 的「契约」
//
// 设计原则：类型只描述「A 能用是什么意思」，不追求花活。
// AI 写错时的报错信息要能直接指向正确写法。

declare module "plain" {
  /** signal —— 唯一状态原语。读 s()，写 s.set(v) 或 s.set(prev => next) */
  export interface Signal<T> {
    (): T;
    set(next: T | ((prev: T) => T)): T;
    /** 不建立依赖地读一次（调试/比较用） */
    peek(): T;
    readonly subs: ReadonlySet<unknown>;
  }

  export function signal<T>(initial: T): Signal<T>;

  /** computed —— 派生值。读法与 signal 完全一致，没有 .get / .value 分支 */
  export function computed<T>(fn: () => T, owner?: Owner): Signal<T>;

  /** effect —— 自动收集依赖，不需要依赖数组，也没有执行顺序要求 */
  export function effect(fn: () => unknown, owner?: Owner): Effect;

  /** batch —— 合并多次写入，只触发一轮 effect */
  export function batch<T>(fn: () => T): T;

  /** 作用域：一次性回收 scope 内创建的所有 effect / 清理回调 */
  export function createScope<T>(fn: (dispose: () => void) => T): {
    value: T;
    dispose(): void;
  };

  /** 注册清理回调（节点卸载 / 分支切换时执行） */
  export function onCleanup(fn: () => void): void;

  /** 在当前 owner 上注册错误处理器（ErrorBoundary 内部用） */
  export function onError(handler: (err: unknown) => void): void;

  /** resolve —— 组件里统一用 resolve(props.x) 取值（不管传进来的是值还是 getter） */
  export function resolve<T>(v: T | (() => T)): T;

  export function stringify(v: unknown): string;

  interface Effect {
    run(): unknown;
    dispose(): void;
    deps: ReadonlySet<unknown>;
    disposed: boolean;
  }

  type Owner = ReadonlySet<() => void>;

  // --- DOM 层 -------------------------------------------------------------

  export function mount(
    target: string | Element,
    node: Renderable | (() => Renderable)
  ): () => void;

  export function insert(parent: Node, get: () => unknown, owner?: Owner): void;
  export function when(
    parent: Node,
    getCond: () => unknown,
    thenFn: () => Renderable,
    elseFn?: (() => Renderable) | null,
    owner?: Owner
  ): void;
  export function each<T>(
    parent: Node,
    getList: () => readonly T[],
    itemFn: (item: T, index: number) => Renderable,
    owner?: Owner
  ): void;

  export interface Slot {
    __plainSlot: true;
    fragment: DocumentFragment;
    start: Node;
    end: Node;
    set(nodes: Renderable): Slot;
    clear(): Slot;
  }
  export function createSlot(label?: string): Slot;
  export function place(parent: Node, node: Renderable | Slot): unknown;
  export function toNodes(v: unknown): Node[];
  export function nodesOf(v: unknown): Node[];

  export type Renderable =
    | Node
    | DocumentFragment
    | Slot
    | string
    | number
    | boolean
    | null
    | undefined
    | Array<Renderable>;

  // --- 异步 / 跨端 --------------------------------------------------------

  export interface Resource<T> {
    data: Signal<T | undefined>;
    loading: Signal<boolean>;
    error: Signal<Error | undefined>;
    refetch(): Promise<T>;
  }

  /** resource(fn) —— fn 会被「同步」调用以便收集依赖，别把 signal 读取放到 await 之后 */
  export function resource<T>(fn: () => T | Promise<T>, owner?: Owner): Resource<T>;

  export function rpc<R = unknown>(name: string, args?: unknown[]): Promise<R>;
  export function setRpcEndpoint(url: string): void;

  /** server(fn) —— 编译期会被物理剥离到 .plain/server.mjs，客户端只剩 RPC 桩 */
  export function server<A extends unknown[], R>(
    fn: (...args: A) => R | Promise<R>
  ): (...args: A) => Promise<R>;

  /** ErrorBoundary —— 子树出错就地降级 */
  export function ErrorBoundary(props: {
    fallback?: (err: Error, retry: () => void) => Renderable;
    children?: any;
  }): Slot;

  // --- 路由 ---------------------------------------------------------------

  export type RouteProps = {
    params: Record<string, string>;
    path: string;
  };

  export interface Route {
    path: string;
    component: (props: RouteProps) => Renderable;
  }

  export interface Router {
    path: Signal<string>;
    current(): { route: Route | null; params: Record<string, string>; path: string };
    params(): Record<string, string>;
    route(): Route | null;
    navigate(to: string, replace?: boolean): void;
    Link(props: { to: string | (() => string); children?: () => Renderable }): Node;
    render(container: Node): () => void;
  }

  export function createRouter(options: {
    routes: Route[];
    mode?: "history" | "hash";
  }): Router;
}

declare module "plain/server" {
  export function rpcMiddleware(options?: {
    manifest?: string;
    endpoint?: string;
    handlers?: Record<string, (...args: any[]) => any>;
  }): (req: any, res: any, next?: () => void) => void;

  export function staticMiddleware(rootDir: string, options?: { spa?: boolean }): (req: any, res: any, next?: () => void) => void;

  export function serve(options?: {
    dist?: string;
    manifest?: string;
    port?: number;
    endpoint?: string;
  }): Promise<import("http").Server>;

  export function loadHandlers(manifest?: string): Promise<Record<string, (...args: any[]) => any>>;

  export function renderToString(
    component: () => any,
    options?: { wait?: number; container?: boolean }
  ): Promise<string>;

  export function renderToStringSync(component: () => any): string;
}

declare module "plain/vite" {
  import type { Plugin } from "vite";
  export default function plainPlugin(options?: {
    serverEntry?: string;
    include?: RegExp;
    rpc?: boolean;
  }): Plugin;
}

// ---------------------------------------------------------------------------
// JSX 类型：不做过度约束，重点是让「合法写法不报错」
// ---------------------------------------------------------------------------
declare namespace JSX {
  /** 合法返回值：普通 Node 或 Slot（Slot 用于「事后整体替换内容」的组件） */
  type Element = Node | import("plain").Slot;

  interface ElementChildrenAttribute {
    children: any;
  }

  interface IntrinsicAttributes {
    key?: string | number;
  }

  type MaybeGetter<T> = T | (() => T);

  interface CommonAttributes {
    key?: string | number;
    id?: MaybeGetter<string>;
    class?: MaybeGetter<string>;
    className?: MaybeGetter<string>;
    style?: MaybeGetter<string | Record<string, string | number>>;
    title?: MaybeGetter<string>;
    hidden?: MaybeGetter<boolean>;
    onClick?: (e: MouseEvent) => void;
    onKeyDown?: (e: KeyboardEvent) => void;
    onKeyUp?: (e: KeyboardEvent) => void;
    children?: any;
    /** 其余 / data-* / aria-* / on* 一律放行 */
    [attr: string]: any;
  }

  /** 输入框事件：target 直接就是 input，省得每次手写 as HTMLInputElement */
  type InputEv = Event & { target: HTMLInputElement };

  interface InputAttributes extends CommonAttributes {
    type?: string;
    value?: MaybeGetter<string>;
    placeholder?: MaybeGetter<string>;
    checked?: MaybeGetter<boolean>;
    disabled?: MaybeGetter<boolean>;
    readOnly?: MaybeGetter<boolean>;
    maxLength?: MaybeGetter<number>;
    min?: MaybeGetter<string | number>;
    max?: MaybeGetter<string | number>;
    step?: MaybeGetter<string | number>;
    pattern?: MaybeGetter<string>;
    autoComplete?: MaybeGetter<string>;
    onInput?: (e: InputEv) => void;
    onChange?: (e: InputEv) => void;
    onFocus?: (e: FocusEvent) => void;
    onBlur?: (e: FocusEvent) => void;
  }

  interface AnchorAttributes extends CommonAttributes {
    href?: MaybeGetter<string>;
    target?: string;
    rel?: string;
    download?: string;
  }

  interface ImageAttributes extends CommonAttributes {
    src?: MaybeGetter<string>;
    alt?: MaybeGetter<string>;
    width?: MaybeGetter<string | number>;
    height?: MaybeGetter<string | number>;
  }

  interface FormAttributes extends CommonAttributes {
    action?: MaybeGetter<string>;
    method?: string;
    onSubmit?: (e: SubmitEvent) => void;
  }

  interface MediaAttributes extends CommonAttributes {
    src?: MaybeGetter<string>;
    controls?: MaybeGetter<boolean>;
    autoplay?: MaybeGetter<boolean>;
    loop?: MaybeGetter<boolean>;
    muted?: MaybeGetter<boolean>;
  }

  interface IntrinsicElements {
    a: AnchorAttributes;
    abbr: CommonAttributes;
    address: CommonAttributes;
    area: CommonAttributes;
    article: CommonAttributes;
    aside: CommonAttributes;
    audio: MediaAttributes;
    b: CommonAttributes;
    base: CommonAttributes;
    bdo: CommonAttributes;
    blockquote: CommonAttributes;
    body: CommonAttributes;
    br: CommonAttributes;
    button: CommonAttributes;
    canvas: CommonAttributes;
    caption: CommonAttributes;
    cite: CommonAttributes;
    code: CommonAttributes;
    col: CommonAttributes;
    colgroup: CommonAttributes;
    data: CommonAttributes;
    datalist: CommonAttributes;
    dd: CommonAttributes;
    del: CommonAttributes;
    details: CommonAttributes;
    dfn: CommonAttributes;
    dialog: CommonAttributes;
    div: CommonAttributes;
    dl: CommonAttributes;
    dt: CommonAttributes;
    em: CommonAttributes;
    embed: CommonAttributes;
    fieldset: CommonAttributes;
    figcaption: CommonAttributes;
    figure: CommonAttributes;
    footer: CommonAttributes;
    form: FormAttributes;
    h1: CommonAttributes;
    h2: CommonAttributes;
    h3: CommonAttributes;
    h4: CommonAttributes;
    h5: CommonAttributes;
    h6: CommonAttributes;
    head: CommonAttributes;
    header: CommonAttributes;
    hgroup: CommonAttributes;
    hr: CommonAttributes;
    html: CommonAttributes;
    i: CommonAttributes;
    iframe: CommonAttributes;
    img: ImageAttributes;
    input: InputAttributes;
    ins: CommonAttributes;
    kbd: CommonAttributes;
    label: CommonAttributes;
    legend: CommonAttributes;
    li: CommonAttributes;
    link: CommonAttributes;
    main: CommonAttributes;
    map: CommonAttributes;
    mark: CommonAttributes;
    menu: CommonAttributes;
    meta: CommonAttributes;
    meter: CommonAttributes;
    nav: CommonAttributes;
    noscript: CommonAttributes;
    object: CommonAttributes;
    ol: CommonAttributes;
    optgroup: CommonAttributes;
    option: InputAttributes;
    output: CommonAttributes;
    p: CommonAttributes;
    param: CommonAttributes;
    picture: CommonAttributes;
    pre: CommonAttributes;
    progress: CommonAttributes;
    q: CommonAttributes;
    rp: CommonAttributes;
    rt: CommonAttributes;
    ruby: CommonAttributes;
    s: CommonAttributes;
    samp: CommonAttributes;
    script: CommonAttributes;
    search: CommonAttributes;
    section: CommonAttributes;
    select: InputAttributes;
    slot: CommonAttributes;
    small: CommonAttributes;
    source: CommonAttributes;
    span: CommonAttributes;
    strong: CommonAttributes;
    style: CommonAttributes;
    sub: CommonAttributes;
    summary: CommonAttributes;
    sup: CommonAttributes;
    table: CommonAttributes;
    tbody: CommonAttributes;
    td: CommonAttributes;
    template: CommonAttributes;
    textarea: InputAttributes;
    tfoot: CommonAttributes;
    th: CommonAttributes;
    thead: CommonAttributes;
    time: CommonAttributes;
    title: CommonAttributes;
    tr: CommonAttributes;
    track: CommonAttributes;
    u: CommonAttributes;
    ul: CommonAttributes;
    var: CommonAttributes;
    video: MediaAttributes;
    wbr: CommonAttributes;
    /** 未列出的标签/自定义元素也放行 */
    [tag: string]: CommonAttributes;
  }
}
