// Plain 公共类型 —— 由 tsc 编译时自动生成到 dist/*.d.ts（不再手写 .d.ts）
//
// 这里只描述「A 能用是什么意思」，不追求花活；AI 写错时的报错信息要能直接
// 指向正确写法。全局 JSX 命名空间也在此声明，随构建一并产出。

/** signal —— 唯一状态原语。读 s()，写 s.set(v) 或 s.set(prev => next) */
export interface Signal<T> {
  (): T;
  set(next: T | ((prev: T) => T)): T;
  /** 不建立依赖地读一次（调试/比较用） */
  peek(): T;
  readonly subs: ReadonlySet<unknown>;
}

/** effect 句柄：可手动重跑 / 回收 */
export interface Effect {
  run(): unknown;
  dispose(): void;
  deps: ReadonlySet<unknown>;
  disposed: boolean;
}

/** owner = 一组清理回调（Set of dispose fn），用于作用域回收 */
export type Owner = ReadonlySet<() => void>;

/** 组件返回值 / 插值可接受的任意可渲染值 */
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

/** Slot —— 带锚点的插槽，用于「事后整体替换内容」的组件（ErrorBoundary/路由容器/懒加载） */
export interface Slot {
  __plainSlot: true;
  fragment: DocumentFragment;
  start: Node;
  end: Node;
  set(nodes: Renderable): Slot;
  clear(): Slot;
}

/** resource —— 自动带 loading / data / error 的异步资源 */
export interface Resource<T> {
  data: Signal<T | undefined>;
  loading: Signal<boolean>;
  error: Signal<Error | undefined>;
  refetch(): Promise<T>;
}

/** 路由参数 */
export type RouteProps = {
  params: Record<string, string>;
  path: string;
};

/** 单条路由定义 */
export interface Route {
  path: string;
  component: (props: RouteProps) => Renderable;
}

/** 路由器实例 */
export interface Router {
  path: Signal<string>;
  current(): { route: Route | null; params: Record<string, string>; path: string };
  params(): Record<string, string>;
  route(): Route | null;
  navigate(to: string, replace?: boolean): void;
  Link(props: { to: string | (() => string); children?: () => Renderable }): Node;
  render(container: Node): () => void;
}

// ---------------------------------------------------------------------------
// JSX 类型：不做过度约束，重点是让「合法写法不报错」
// ---------------------------------------------------------------------------
declare global {
  namespace JSX {
    /** 合法返回值：普通 Node 或 Slot（Slot 用于「事后整体替换内容」的组件） */
    type Element = Node | Slot;

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
}
