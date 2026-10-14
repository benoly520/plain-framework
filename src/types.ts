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

/**
 * ref 回调 —— 命令式 DOM 逃逸口（≈ 平台的 connectedCallback）。
 * 元素连入文档后调用一次；可返回一个清理函数（≈ disconnectedCallback）。
 * 类型由标签推导，无需手写泛型。见 docs/rfcs/ref-escape-hatch.md。
 *
 * 用「bivariance hack」（同 React 的 EventHandler）：让更窄的元素类型
 * （如 Ref<HTMLCanvasElement>）可赋给基类型，各 Attributes 接口才能安全收窄 ref。
 */
export type Ref<T extends Element = HTMLElement> = {
  bivarianceHack(el: T): void | (() => void);
}["bivarianceHack"];

/**
 * Context —— 跨层传值（依赖注入），并让 SSR 下的请求级数据有正确的归属。
 *
 * 用法：`const Ctx = createContext<T>(默认值)`；`<Ctx.Provider value={...}>…</Ctx.Provider>`；
 * 消费端 `const v = useContext(Ctx)` —— `v` 是可调用 getter，读法 `v()`（与 signal 一致）。
 * 设计见 docs/rfcs/context-and-ssr-isolation.md。
 */
export interface Context<T> {
  readonly __plainContext: true;
  /** 没有任何 Provider 时读到的值（显式声明，不会静默变成 undefined） */
  readonly defaultValue: T;
  /** `<Ctx.Provider value={...}>children</Ctx.Provider>` */
  Provider(props: { value: T; children?: any }): Node;
}

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

    /** bivariance hack：更窄的事件类型也能赋给基类型（同 React 的 EventHandler） */
    type EventHandler<E extends Event = Event> = {
      bivarianceHack(e: E): void;
    }["bivarianceHack"];

    /**
     * 所有内建元素共用的属性集合。
     *
     * ⚠️ 这里**故意不放** `[attr: string]: any` —— 那个口子会让属性名拼错（`scr` / `classNmae`）
     * 与类型写错（`checked="yes"`）在 `tsc` 下静默通过、运行时静默失效。
     * 去掉它之后：拼错的属性名 / 写错的类型会在编辑器与 `tsc` 下当场报错。
     *
     * **边界（诚实说明）**：这是一套**共用**属性，不按元素区分 ——
     * 能拦住「拼写错 / 类型错」，但**不拦「属性放错元素」**（如 `<div colSpan={2}>` 不报）。
     * 未知标签（自定义元素）走 `IntrinsicElements` 的兜底，保持宽松。
     */
    interface CommonAttributes {
      // ---- 身份 / 样式 / 通用 ----
      key?: string | number;
      id?: MaybeGetter<string>;
      class?: MaybeGetter<string>;
      className?: MaybeGetter<string>;
      style?: MaybeGetter<string | Record<string, string | number>>;
      title?: MaybeGetter<string>;
      hidden?: MaybeGetter<boolean>;
      /** 命令式 DOM 逃逸口：元素连入文档后调用一次，可返回清理函数 */
      ref?: Ref;
      children?: any;

      // ---- HTML 全局属性 ----
      accessKey?: MaybeGetter<string>;
      autoCapitalize?: MaybeGetter<string>;
      autoFocus?: MaybeGetter<boolean>;
      contentEditable?: MaybeGetter<boolean>;
      dir?: MaybeGetter<"ltr" | "rtl" | "auto">;
      draggable?: MaybeGetter<boolean>;
      enterKeyHint?: MaybeGetter<string>;
      inert?: MaybeGetter<boolean>;
      inputMode?: MaybeGetter<string>;
      is?: string;
      lang?: MaybeGetter<string>;
      nonce?: string;
      part?: string;
      role?: MaybeGetter<string>;
      slot?: string;
      spellcheck?: MaybeGetter<boolean>;
      tabIndex?: MaybeGetter<number>;
      /** 编译器 PROP_ALIAS 也认小写 HTML 写法 */
      tabindex?: MaybeGetter<number>;
      translate?: MaybeGetter<"yes" | "no">;

      // ---- 常用元素属性（跨元素共用一套；见上方边界说明）----
      accept?: MaybeGetter<string>;
      acceptCharset?: MaybeGetter<string>;
      action?: MaybeGetter<string>;
      allow?: MaybeGetter<string>;
      allowFullScreen?: MaybeGetter<boolean>;
      alt?: MaybeGetter<string>;
      as?: MaybeGetter<string>;
      async?: MaybeGetter<boolean>;
      autoComplete?: MaybeGetter<string>;
      /** 编译器 PROP_ALIAS 接受小写 */
      autocomplete?: MaybeGetter<string>;
      autoplay?: MaybeGetter<boolean>;
      capture?: MaybeGetter<string | boolean>;
      checked?: MaybeGetter<boolean>;
      cite?: MaybeGetter<string>;
      cols?: MaybeGetter<number>;
      colSpan?: MaybeGetter<number>;
      controls?: MaybeGetter<boolean>;
      crossOrigin?: MaybeGetter<string>;
      dateTime?: MaybeGetter<string>;
      decoding?: MaybeGetter<string>;
      default?: MaybeGetter<boolean>;
      defer?: MaybeGetter<boolean>;
      disabled?: MaybeGetter<boolean>;
      download?: MaybeGetter<string | boolean>;
      enctype?: MaybeGetter<string>;
      for?: MaybeGetter<string>;
      htmlFor?: MaybeGetter<string>;
      form?: MaybeGetter<string>;
      formAction?: MaybeGetter<string>;
      formMethod?: MaybeGetter<string>;
      formNoValidate?: MaybeGetter<boolean>;
      formTarget?: MaybeGetter<string>;
      headers?: MaybeGetter<string>;
      height?: MaybeGetter<string | number>;
      href?: MaybeGetter<string>;
      hrefLang?: MaybeGetter<string>;
      integrity?: MaybeGetter<string>;
      kind?: MaybeGetter<string>;
      label?: MaybeGetter<string>;
      list?: MaybeGetter<string>;
      loading?: MaybeGetter<"lazy" | "eager">;
      loop?: MaybeGetter<boolean>;
      max?: MaybeGetter<string | number>;
      maxLength?: MaybeGetter<number>;
      method?: MaybeGetter<string>;
      min?: MaybeGetter<string | number>;
      minLength?: MaybeGetter<number>;
      multiple?: MaybeGetter<boolean>;
      muted?: MaybeGetter<boolean>;
      name?: MaybeGetter<string>;
      noModule?: MaybeGetter<boolean>;
      noValidate?: MaybeGetter<boolean>;
      open?: MaybeGetter<boolean>;
      optimum?: MaybeGetter<number>;
      pattern?: MaybeGetter<string>;
      ping?: MaybeGetter<string>;
      placeholder?: MaybeGetter<string>;
      playsInline?: MaybeGetter<boolean>;
      poster?: MaybeGetter<string>;
      preload?: MaybeGetter<"none" | "metadata" | "auto">;
      readOnly?: MaybeGetter<boolean>;
      /** 编译器 PROP_ALIAS 接受小写 */
      readonly?: MaybeGetter<boolean>;
      referrerPolicy?: MaybeGetter<string>;
      rel?: MaybeGetter<string>;
      required?: MaybeGetter<boolean>;
      reversed?: MaybeGetter<boolean>;
      rows?: MaybeGetter<number>;
      rowSpan?: MaybeGetter<number>;
      sandbox?: MaybeGetter<string>;
      scope?: MaybeGetter<string>;
      selected?: MaybeGetter<boolean>;
      size?: MaybeGetter<number>;
      sizes?: MaybeGetter<string>;
      span?: MaybeGetter<number>;
      src?: MaybeGetter<string>;
      srcDoc?: MaybeGetter<string>;
      srcLang?: MaybeGetter<string>;
      srcSet?: MaybeGetter<string>;
      start?: MaybeGetter<number>;
      step?: MaybeGetter<string | number>;
      target?: MaybeGetter<string>;
      type?: MaybeGetter<string>;
      useMap?: MaybeGetter<string>;
      value?: MaybeGetter<string | number>;
      width?: MaybeGetter<string | number>;
      wrap?: MaybeGetter<string>;

      // ---- data-* / aria-*（模板字面量索引签名：只放行这两种前缀）----
      [key: `data-${string}`]: MaybeGetter<string | number | boolean> | undefined;
      [key: `aria-${string}`]: MaybeGetter<string | number | boolean> | undefined;

      // ---- 事件（枚举而非 on* 兜底：否则 onClikc 之类的拼写错就拦不住了）----
      onClick?: EventHandler<MouseEvent>;
      onDblClick?: EventHandler<MouseEvent>;
      onMouseDown?: EventHandler<MouseEvent>;
      onMouseUp?: EventHandler<MouseEvent>;
      onMouseMove?: EventHandler<MouseEvent>;
      onMouseEnter?: EventHandler<MouseEvent>;
      onMouseLeave?: EventHandler<MouseEvent>;
      onMouseOver?: EventHandler<MouseEvent>;
      onMouseOut?: EventHandler<MouseEvent>;
      onContextMenu?: EventHandler<MouseEvent>;
      onWheel?: EventHandler<WheelEvent>;
      onKeyDown?: EventHandler<KeyboardEvent>;
      onKeyUp?: EventHandler<KeyboardEvent>;
      onKeyPress?: EventHandler<KeyboardEvent>;
      onInput?: EventHandler<InputEv>;
      onChange?: EventHandler<InputEv>;
      onBeforeInput?: EventHandler<InputEvent>;
      onCompositionStart?: EventHandler<CompositionEvent>;
      onCompositionUpdate?: EventHandler<CompositionEvent>;
      onCompositionEnd?: EventHandler<CompositionEvent>;
      onSubmit?: EventHandler<SubmitEvent>;
      onReset?: EventHandler<Event>;
      onFocus?: EventHandler<FocusEvent>;
      onBlur?: EventHandler<FocusEvent>;
      onScroll?: EventHandler<UIEvent>;
      onScrollEnd?: EventHandler<Event>;
      onSelect?: EventHandler<Event>;
      onInvalid?: EventHandler<Event>;
      onToggle?: EventHandler<Event>;
      onClose?: EventHandler<Event>;
      onCancel?: EventHandler<Event>;
      onPointerDown?: EventHandler<PointerEvent>;
      onPointerUp?: EventHandler<PointerEvent>;
      onPointerMove?: EventHandler<PointerEvent>;
      onPointerEnter?: EventHandler<PointerEvent>;
      onPointerLeave?: EventHandler<PointerEvent>;
      onPointerCancel?: EventHandler<PointerEvent>;
      onTouchStart?: EventHandler<TouchEvent>;
      onTouchEnd?: EventHandler<TouchEvent>;
      onTouchMove?: EventHandler<TouchEvent>;
      onTouchCancel?: EventHandler<TouchEvent>;
      onDrag?: EventHandler<DragEvent>;
      onDragStart?: EventHandler<DragEvent>;
      onDragEnd?: EventHandler<DragEvent>;
      onDragEnter?: EventHandler<DragEvent>;
      onDragOver?: EventHandler<DragEvent>;
      onDragLeave?: EventHandler<DragEvent>;
      onDrop?: EventHandler<DragEvent>;
      onCopy?: EventHandler<ClipboardEvent>;
      onCut?: EventHandler<ClipboardEvent>;
      onPaste?: EventHandler<ClipboardEvent>;
      onLoad?: EventHandler<Event>;
      onError?: EventHandler<Event>;
      onAnimationStart?: EventHandler<AnimationEvent>;
      onAnimationEnd?: EventHandler<AnimationEvent>;
      onAnimationIteration?: EventHandler<AnimationEvent>;
      onTransitionEnd?: EventHandler<TransitionEvent>;
      // 媒体事件
      onPlay?: EventHandler<Event>;
      onPause?: EventHandler<Event>;
      onPlaying?: EventHandler<Event>;
      onEnded?: EventHandler<Event>;
      onTimeUpdate?: EventHandler<Event>;
      onDurationChange?: EventHandler<Event>;
      onVolumeChange?: EventHandler<Event>;
      onSeeking?: EventHandler<Event>;
      onSeeked?: EventHandler<Event>;
      onWaiting?: EventHandler<Event>;
      onStalled?: EventHandler<Event>;
      onSuspend?: EventHandler<Event>;
      onCanPlay?: EventHandler<Event>;
      onCanPlayThrough?: EventHandler<Event>;
      onLoadedData?: EventHandler<Event>;
      onLoadedMetadata?: EventHandler<Event>;
      onProgress?: EventHandler<Event>;
    }

    /** 输入框事件：target 直接就是 input，省得每次手写 as HTMLInputElement */
    type InputEv = Event & { target: HTMLInputElement };

    // 下面这些接口只为「把 ref 收窄成对应元素类型」；其余属性共用 CommonAttributes。
    interface InputAttributes extends CommonAttributes {
      ref?: Ref<HTMLInputElement>;
    }

    interface AnchorAttributes extends CommonAttributes {
      ref?: Ref<HTMLAnchorElement>;
    }

    interface ImageAttributes extends CommonAttributes {
      ref?: Ref<HTMLImageElement>;
    }

    interface FormAttributes extends CommonAttributes {
      ref?: Ref<HTMLFormElement>;
    }

    interface MediaAttributes extends CommonAttributes {
      ref?: Ref<HTMLMediaElement>;
    }

    /** canvas：ref 推导为 HTMLCanvasElement（getContext 等命令式 API 的入口） */
    interface CanvasAttributes extends CommonAttributes {
      ref?: Ref<HTMLCanvasElement>;
    }

    /** dialog：ref 推导为 HTMLDialogElement（showModal / close 的入口） */
    interface DialogAttributes extends CommonAttributes {
      ref?: Ref<HTMLDialogElement>;
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
      canvas: CanvasAttributes;
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
      dialog: DialogAttributes;
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
      option: CommonAttributes;
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
      select: CommonAttributes;
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
      textarea: CommonAttributes;
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
      /** 未列出的标签 / 自定义元素：放行（不参与属性校验，避免误伤 web component） */
      [tag: string]: any;
    }
  }
}
