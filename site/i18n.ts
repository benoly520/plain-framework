// 官网文案字典：中英双语。
//
// 「当前语言」是跨层传的值，所以按框架约定走 createContext / useContext ——
// 读法是调用：useContext(I18nCtx)().hero.title（与 signal 同一种读法）。
// 组件里不直接读模块变量，是为了让「切换语言」这件事只有一条数据通路。

import { createContext } from 'plain';
import type { GuideStepId, SampleId } from './samples.js';

/** 语言标识 */
export type Lang = 'zh' | 'en';

/**
 * 恒等泛型函数：把字面量的类型放宽成 string / string[]。
 * 这样 `const en: Copy = {…}` 只校验「键齐不齐、值是不是字符串」，
 * 不会把 '中文' 这类中文字面量当成 en 也必须照抄的必填值。
 */
function defineCopy<T>(copy: T): T {
  return copy;
}

const zh = defineCopy({
  langName: '中文',
  switchTo: 'English',
  nav: {
    live: '跑一跑',
    compare: '对比',
    compile: '编译产物',
    gate: '编译期拦截',
    ai: '面向 AI',
    guide: '快速开始',
    bounds: '边界',
    docs: '文档',
    github: 'GitHub',
  },
  hero: {
    badge: 'v0.3.0 · MIT · 运行时零依赖',
    title: '编译到 DOM 的前端框架',
    titleAccent: '为「AI 写、人来维护」而设计',
    desc:
      'TSX 视图 + signals 响应式 + 编译期物理剥离的 server() 边界。' +
      '没有虚拟 DOM，没有 hook，没有依赖数组，没有 Proxy 魔法。',
    ctaStart: '快速开始',
    ctaDocs: '读文档',
    note: '本站也是用 Plain 写的：你这一页点到的每个交互，都由 signal 驱动。',
    stats: {
      vdom: '虚拟 DOM',
      state: '状态原语',
      gzip: '运行时 gzip',
      deps: '硬依赖',
    },
  },
  demo: {
    title: '这些组件就是 Plain 写的',
    desc: '下面两个组件直接编译进这一页 —— 不是 iframe，也不是录屏。',
    counterLabel: '计数器 · signal + computed',
    counterAdd: '+1',
    counterReset: '归零',
    counterNote: '两行状态，没有 hook，也没有 deps 数组：读 count()，写 count.set(v)。',
    listLabel: '列表 · keyed 复用',
    listPlaceholder: '写一条待办…',
    listAdd: '加到末尾',
    listPrepend: '插到最前面',
    listEmpty: '列表空了',
    listRemove: '删掉这一条',
    listNote: '顶层元素写了 key：插到最前面时，已有行的 DOM 节点不会被重建。',
    seed: ['读一遍这 5 条规则', '把 server() 挪到服务端', '用 .map 渲染列表'],
  },
  compare: {
    title: '10 秒理解 Plain',
    desc: '同一个活儿，传统框架与 Plain 的差别。',
    dim: '维度',
    old: '传统框架',
    plain: 'Plain',
    rows: [
      {
        k: 'view',
        dim: '视图',
        old: '自己写 VNode、跑 DOM diff',
        plain: '编译期生成建 DOM 的代码，运行时没有虚拟 DOM',
      },
      {
        k: 'state',
        dim: '状态',
        old: 'useState / ref / reactive / store 多套',
        plain: '只有 signal 一种',
      },
      {
        k: 'deps',
        dim: '依赖收集',
        old: 'deps 数组、手动 memo',
        plain: '自动收集，没有依赖数组',
      },
      {
        k: 'effect',
        dim: '副作用顺序',
        old: 'hook 顺序必须稳定',
        plain: '没有 hook 规则，effect 就是普通函数',
      },
      {
        k: 'boundary',
        dim: '组件边界',
        old: '隐式：一切都在浏览器',
        plain: 'server() 显式标注，编译期物理剥离',
      },
      {
        k: 'safe',
        dim: '安全',
        old: 'innerHTML 随手可写',
        plain: '编译产物里不可能出现 innerHTML',
      },
    ],
  },
  rules: {
    title: '核心规则，只有 5 条',
    desc: '没有第六个概念 —— 记住这 5 条就能写完整个应用。',
    items: [
      {
        k: 'state',
        title: '状态只有 signal',
        desc: '读 s()，写 s.set(v)；派生用 computed(fn)，读法一样。没有 .value，没有 .get()。',
      },
      {
        k: 'component',
        title: '组件就是「返回 JSX 的函数」',
        desc: '必须写成 return (<jsx />)，编译期会被展开成建 DOM 的代码。',
      },
      {
        k: 'list',
        title: '列表用 .map，条件用三元或 &&',
        desc: '编译成 each() / when()，行级响应式自动生效，不用 memo。',
      },
      {
        k: 'effect',
        title: '副作用用 effect(fn)',
        desc: '依赖自动收集，随组件 / 列表行一起回收；要额外清理就用 onCleanup。',
      },
      {
        k: 'server',
        title: '服务端代码用 server() 包起来',
        desc: '编译期物理挪到服务端，客户端产物里只剩一个 rpc 桩。',
      },
    ],
  },
  compile: {
    title: '源码 → 编译产物',
    desc: '右边不是示意代码，是把左边真跑一遍编译器得到的产物。',
    from: '源码',
    to: '产物（构建后）',
    tabs: {
      counter: '计数器',
      list: '列表',
      server: 'server()',
    },
    notes: {
      counter: '产物里没有虚拟 DOM：每个插值各绑定一个文本节点，改 count 只改那一行。',
      list: 'each() 带行级响应式，顶层 key 让节点跟着数据走：头插 / 重排复用已有 <li>。',
      server: '函数体一行都没进客户端 —— 只剩一个 rpc("stats", args) 桩；函数体在服务端清单里。',
    } as Record<SampleId, string>,
  },
  gate: {
    title: '写错就在编译期失败',
    desc:
      '契约检查默认接在构建流水线上：AI 的典型错误让构建失败，而不是留到运行时炸。' +
      '能自动修的直接改源码，修不了的点名改法。',
    code: '错误码',
    meaning: '拦下的写法',
    rows: [
      {
        k: 'e1101',
        code: 'PLAIN_E1101',
        text: '直接给 signal 变量赋值 → 自动改成 count.set(v)',
      },
      {
        k: 'e1102',
        code: 'PLAIN_E1102',
        text: 'JSX 里把 signal 当值用 → 自动补上 ()',
      },
      {
        k: 'e1006',
        code: 'PLAIN_E1006',
        text: 'server() 函数体引用了外部变量（闭包不会跟到服务端）',
      },
      {
        k: 'e1007',
        code: 'PLAIN_E1007',
        text: 'server() 的参数 / 返回值无法 JSON 序列化',
      },
      {
        k: 'e1005',
        code: 'PLAIN_E1005',
        text: '列表的 key 与 index 同时用：两种语义只能选一个',
      },
      {
        k: 'e1104',
        code: 'PLAIN_E1104',
        text: 'innerHTML / outerHTML：安全红线，直接失败',
      },
    ],
    cliTitle: 'plaindev check 的真实输出',
  },
  ai: {
    title: '面向 AI 的设计',
    desc: '每一条设计决定，都对应「AI 常犯的一个错」。',
    fail: 'AI 常犯的错',
    fix: 'Plain 的应对',
    rows: [
      {
        k: 'deps',
        fail: '忘了依赖数组、memo 值变旧',
        fix: '依赖自动收集，没有依赖数组这个概念',
      },
      {
        k: 'hook',
        fail: 'hook 顺序写错、条件调用 hook',
        fix: '没有 hook 概念，effect 就是普通函数',
      },
      {
        k: 'state',
        fail: '混用多套状态方案',
        fix: '只有 signal，一种读法',
      },
      {
        k: 'call',
        fail: 'JSX 里忘了调用（写成 {count}）',
        fix: '契约检查自动修成 {count()}',
      },
      {
        k: 'leak',
        fail: '把服务端代码写进浏览器（泄密）',
        fix: '编译期物理剥离，泄漏在结构上不可能',
      },
      {
        k: 'xss',
        fail: '拼字符串 innerHTML → XSS',
        fix: '产物不生成 innerHTML，插值永远走文本节点',
      },
      {
        k: 'list',
        fail: '列表不更新（就地改数据 / key 写错）',
        fix: '行级响应式自动生效，不写 key 也正确',
      },
    ],
  },
  guide: {
    title: '快速开始',
    desc: '四条命令，一个项目。',
    cmds: {
      deps: '装依赖（vite 是唯一的硬依赖，加上 typescript）',
      dev: '开发：dev server + /_plain/rpc，组件改动走 HMR',
      build: '构建：产出 dist/ 与服务端清单 .plain/server.mjs',
      serve: '生产：静态托管 + RPC，一条命令',
    } as Record<GuideStepId, string>,
    npmNote:
      '⚠️ 框架尚未发布到 npm：「pnpm add plain」现在还装不到包。请先从仓库构建' +
      '（pnpm install && pnpm run build），或用 packages/create-plain 的 link: 本地接入方式' +
      '（见其 README）。',
    viteLabel: 'vite.config.js',
    tsLabel: 'tsconfig.json（jsx: preserve 必须）',
    copy: '复制',
    copied: '已复制',
  },
  bounds: {
    title: '边界与已知限制',
    desc: '这个项目对「没做完」的部分不假装。',
    todoTitle: '还没实现（有阶段计划）',
    todos: [
      '组件级细粒度热更新：目前最细到「挂载点」，改到被共用的模块会重跑该挂载点的根组件',
      'SSR 流式渐进内容：现在只做到「先刷 shell 抢首字节」，内容仍是一次性写入',
      'RPC 高频调用合并：可选的 setRpcBatching 已提供，默认不开',
      '多入口 / 分包：框架侧的清单隔离已落地，打包侧走 Vite 自己的配置',
    ],
    nongoalTitle: '明确非目标',
    nongoals: ['并发渲染 / 时间切片 —— 与「编译到 DOM、稳定小内核」的核心取舍冲突，明确不做'],
    tradeoffTitle: '刻意取舍（不是 bug）',
    tradeoffs: [
      '组件必须写成 return (<jsx />)：限制写法，换来产物完全可预测 + 编译期报错',
      'server() 的闭包不会跟到服务端：故意让跨环境的数据依赖暴露在明面上',
      '没有 .value 与 .get()：一种读法，少一个选择就少一类错误',
    ],
  },
  footer: {
    builtWith:
      '本站也是用 Plain 构建的（site/）：signal / computed / Context / keyed 列表都在这一页跑着。',
    docs: '文档',
    repo: '仓库',
    license: 'MIT License · 版权归 benoly520',
  },
});

/** 字典的形状（以中文版为准，英文版必须键齐） */
export type Copy = typeof zh;

const en: Copy = {
  langName: 'English',
  switchTo: '中文',
  nav: {
    live: 'Live demo',
    compare: 'Compare',
    compile: 'Compiled',
    gate: 'Early failures',
    ai: 'For AI',
    guide: 'Quick start',
    bounds: 'Limits',
    docs: 'Docs',
    github: 'GitHub',
  },
  hero: {
    badge: 'v0.3.0 · MIT · zero-dependency runtime',
    title: 'A frontend framework that compiles to the DOM',
    titleAccent: 'Designed for "AI writes it, humans maintain it"',
    desc:
      'TSX views + signals reactivity + a server() boundary physically stripped at compile time. ' +
      'No virtual DOM, no hooks, no dependency arrays, no Proxy magic.',
    ctaStart: 'Quick start',
    ctaDocs: 'Read the docs',
    note: 'This site is built with Plain too: every click on this page is driven by a signal.',
    stats: {
      vdom: 'virtual DOM',
      state: 'state primitives',
      gzip: 'runtime gzip',
      deps: 'hard deps',
    },
  },
  demo: {
    title: 'These components are written in Plain',
    desc: 'Both are compiled into this very page — no iframe, no screen recording.',
    counterLabel: 'Counter · signal + computed',
    counterAdd: '+1',
    counterReset: 'Reset',
    counterNote: 'Two lines of state, no hooks, no deps array: read count(), write count.set(v).',
    listLabel: 'List · keyed reuse',
    listPlaceholder: 'Write a todo…',
    listAdd: 'Append',
    listPrepend: 'Prepend',
    listEmpty: 'The list is empty',
    listRemove: 'Remove this row',
    listNote: 'The top-level element has a key: prepending does not rebuild existing rows.',
    seed: ['Read the 5 rules', 'Move server() to the server', 'Render the list with .map'],
  },
  compare: {
    title: 'Understand Plain in 10 seconds',
    desc: 'The same job, in a traditional framework and in Plain.',
    dim: 'Dimension',
    old: 'Traditional frameworks',
    plain: 'Plain',
    rows: [
      {
        k: 'view',
        dim: 'Views',
        old: 'hand-written VNodes, runtime DOM diffing',
        plain: 'DOM-building code generated at compile time, no virtual DOM',
      },
      {
        k: 'state',
        dim: 'State',
        old: 'useState / ref / reactive / store',
        plain: 'only signal',
      },
      {
        k: 'deps',
        dim: 'Dependency tracking',
        old: 'deps arrays, manual memo',
        plain: 'automatic, no deps array exists',
      },
      {
        k: 'effect',
        dim: 'Side-effect order',
        old: 'hook order must stay stable',
        plain: 'no hook rules, effect is just a function',
      },
      {
        k: 'boundary',
        dim: 'Component boundary',
        old: 'implicit, everything in the browser',
        plain: 'server() is explicit, physically stripped',
      },
      {
        k: 'safe',
        dim: 'Safety',
        old: 'innerHTML is one keystroke away',
        plain: 'the compiled output cannot contain innerHTML',
      },
    ],
  },
  rules: {
    title: 'Five rules, that is all',
    desc: 'There is no sixth concept — these five are enough to write a whole app.',
    items: [
      {
        k: 'state',
        title: 'State is only signal',
        desc:
          'Read s(), write s.set(v); derive with computed(fn), the same read syntax. ' +
          'No .value, no .get().',
      },
      {
        k: 'component',
        title: 'A component is a function that returns JSX',
        desc:
          'It must be written as return (<jsx />); the compiler expands it into DOM-building code.',
      },
      {
        k: 'list',
        title: 'Lists with .map, conditions with ?: or &&',
        desc: 'Compiled into each() / when(); row-level reactivity is automatic, no memo needed.',
      },
      {
        k: 'effect',
        title: 'Side effects with effect(fn)',
        desc:
          'Dependencies are collected automatically and reclaimed with the component or ' +
          'list row; use onCleanup for extra cleanup.',
      },
      {
        k: 'server',
        title: 'Server code goes inside server()',
        desc: 'Physically moved to the server at compile time; the client keeps only an RPC stub.',
      },
    ],
  },
  compile: {
    title: 'Source → compiled output',
    desc: 'The right side is not illustrative: it is what the compiler really returns.',
    from: 'Source',
    to: 'Output (built)',
    tabs: {
      counter: 'Counter',
      list: 'List',
      server: 'server()',
    },
    notes: {
      counter:
        'No virtual DOM in the output: each interpolation binds to one text node, so writing ' +
        'count updates that line only.',
      list:
        'each() carries row-level reactivity, and the top-level key lets nodes follow the data: ' +
        'prepending reuses existing <li> nodes.',
      server:
        'Not a single line of the body reaches the client — only an rpc("stats", args) stub. ' +
        'The body lives in the server manifest.',
    } as Record<SampleId, string>,
  },
  gate: {
    title: 'Mistakes fail at compile time',
    desc:
      'Contract checks are wired into the build pipeline by default: the mistakes AI makes most ' +
      'often fail the build instead of blowing up at runtime. What can be auto-fixed is rewritten.',
    code: 'Code',
    meaning: 'What it stops',
    rows: [
      {
        k: 'e1101',
        code: 'PLAIN_E1101',
        text: 'assigning to a signal variable → auto-fixed to count.set(v)',
      },
      {
        k: 'e1102',
        code: 'PLAIN_E1102',
        text: 'a signal used as a value in JSX → auto-fixed by adding ()',
      },
      {
        k: 'e1006',
        code: 'PLAIN_E1006',
        text: 'a server() body referencing an outer variable (closures do not follow)',
      },
      {
        k: 'e1007',
        code: 'PLAIN_E1007',
        text: 'a server() argument / return value that is not JSON-serializable',
      },
      {
        k: 'e1005',
        code: 'PLAIN_E1005',
        text: 'list key and index used together: pick one semantics',
      },
      {
        k: 'e1104',
        code: 'PLAIN_E1104',
        text: 'innerHTML / outerHTML: security red line, fails the build',
      },
    ],
    cliTitle: 'Real output of plaindev check',
  },
  ai: {
    title: 'Designed for AI',
    desc: 'Every design decision answers one mistake that AI commonly makes.',
    fail: 'Common AI failure',
    fix: 'How Plain answers it',
    rows: [
      {
        k: 'deps',
        fail: 'forgetting deps arrays, stale memoized values',
        fix: 'dependencies are collected automatically; no deps array exists',
      },
      {
        k: 'hook',
        fail: 'wrong hook order, conditional hook calls',
        fix: 'no hook concept at all; effect is a plain function',
      },
      {
        k: 'state',
        fail: 'mixing several state systems',
        fix: 'only signal, one read syntax',
      },
      {
        k: 'call',
        fail: 'forgetting the call in JSX ({count})',
        fix: 'the contract check auto-fixes it to {count()}',
      },
      {
        k: 'leak',
        fail: 'shipping server code to the browser (leaking secrets)',
        fix: 'physically stripped at compile time; leaking is structurally impossible',
      },
      {
        k: 'xss',
        fail: 'string-built innerHTML → XSS',
        fix: 'the output never generates innerHTML; interpolation goes through text nodes',
      },
      {
        k: 'list',
        fail: 'list updates silently doing nothing',
        fix: 'row-level reactivity is automatic; correct even without keys',
      },
    ],
  },
  guide: {
    title: 'Quick start',
    desc: 'Four commands and you have an app.',
    cmds: {
      deps: 'Install deps (vite is the only hard dependency, plus typescript)',
      dev: 'Dev: dev server + /_plain/rpc, component edits go through HMR',
      build: 'Build: emits dist/ and the server manifest .plain/server.mjs',
      serve: 'Production: static hosting + RPC in one command',
    } as Record<GuideStepId, string>,
    npmNote:
      '⚠️ Not published to npm yet: "pnpm add plain" cannot resolve the package today. ' +
      'Build the framework from the repository first (pnpm install && pnpm run build), ' +
      'or use the link: local setup from packages/create-plain (see its README).',
    viteLabel: 'vite.config.js',
    tsLabel: 'tsconfig.json (jsx: preserve is required)',
    copy: 'Copy',
    copied: 'Copied',
  },
  bounds: {
    title: 'Boundaries and known limits',
    desc: 'This project does not pretend about what is unfinished.',
    todoTitle: 'Not implemented yet (staged plan exists)',
    todos: [
      'Component-level (fine-grained) hot-swap: the finest granularity today is the mount ' +
        'point; editing a shared module re-runs the mount point root component',
      'SSR streaming (progressive content): "stream" only flushes the shell early, the ' +
        'content is still written in one chunk',
      'RPC request batching: the optional setRpcBatching exists, off by default',
      'Multi-entry / code splitting: manifest isolation landed framework-side, bundling goes ' +
        'through Vite config',
    ],
    nongoalTitle: 'Explicit non-goals',
    nongoals: [
      'Concurrent rendering / time slicing — it conflicts with the core trade-off of ' +
        '"compile to DOM, small stable core", so it is not planned',
    ],
    tradeoffTitle: 'Deliberate trade-offs (not bugs)',
    tradeoffs: [
      'Components must be written as return (<jsx />): restricts the writing, buys a fully ' +
        'predictable output and compile-time errors',
      'A server() closure does not follow it to the server: cross-environment data dependencies ' +
        'are deliberately made explicit',
      'No .value and no .get(): one read syntax, one fewer choice means one fewer class of bugs',
    ],
  },
  footer: {
    builtWith:
      'This site is built with Plain too (site/): signal / computed / Context / keyed lists all ' +
      'run on this page.',
    docs: 'Docs',
    repo: 'Repository',
    license: 'MIT License · copyright benoly520',
  },
};

/** 两种语言的完整字典 */
export const COPIES: Record<Lang, Copy> = { zh, en };

/** 语言上下文：默认中文 */
export const I18nCtx = createContext<Copy>(zh);
