import { ERROR_CATALOG, type PlainErrorCode } from './errors.js';
import type { LintIssue } from './lint.js';

/** 支持的诊断语言。 */
export type PlainLocale = 'zh-CN' | 'en';

/** 解析诊断语言；显式非法值抛错，auto 会继续读取环境变量。 */
export function resolveLocale(value?: string): PlainLocale {
  const explicit = value && value.toLowerCase() !== 'auto' ? value : undefined;
  const raw = [explicit, process.env.PLAIN_LOCALE, process.env.LC_ALL,
    process.env.LC_MESSAGES, process.env.LANG]
    .find((candidate) => candidate && candidate.toLowerCase() !== 'auto') || 'en';
  const normalized = raw.trim().toLowerCase().replace(/_/g, '-').split('.')[0];
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  if (explicit) {
    throw new Error(`Unsupported locale: ${value}`);
  }
  return 'en';
}

const summaries: Record<PlainErrorCode, string> = {
  PLAIN_E1001: 'The compiler does not recognize this JSX form',
  PLAIN_E1002: 'The generated output cannot be parsed as JavaScript',
  PLAIN_E1003: 'The generated output still contains JSX (compiler bug)',
  PLAIN_E1004: 'Unsupported syntax node (compiler bug)',
  PLAIN_E1005: 'A list cannot use both key and index',
  PLAIN_E1006: '`server()` references an external variable',
  PLAIN_E1007: '`server()` arguments or return value are not JSON-serializable',
  PLAIN_E1008: 'JSX attribute spread is not supported',
  PLAIN_E1009: '`ref` cannot be used on a component',
  PLAIN_E1010: '`ref` must be a function',
  PLAIN_E1011: 'A `ref` callback cannot be async',
  PLAIN_E1012: '`server()` must receive an inline function',
  PLAIN_E1101: 'Assigning to a signal requires `.set()`',
  PLAIN_E1102: 'A signal must be called with `()` when read in JSX',
  PLAIN_E1103: 'React hooks are not available in Plain',
  PLAIN_E1104: 'Unsafe HTML APIs are not allowed',
  PLAIN_E1105: 'Destructuring props silently loses reactivity',
  PLAIN_E1106: 'Mutating a value held by a signal loses updates',
  PLAIN_E1107: 'Storing a prop value in a variable creates a snapshot',
  PLAIN_E1109: '`effect(async () => …)` breaks dependency tracking',
  PLAIN_E1110: '`effect` reads and writes the same signal',
  PLAIN_E1111: '`computed` must not write to a signal',
  PLAIN_E1112: 'A prop value was captured in a variable',
  PLAIN_E1113: 'Creating `resource()` at module scope is not allowed',
  PLAIN_E1114: 'The value returned by useContext is a getter and must be called',
  PLAIN_E1115: 'A React-style attribute name was used',
  PLAIN_E1201: 'A top-level reactive call references a later const',
  PLAIN_E1202: 'A derived prop or signal read was captured as a snapshot',
  PLAIN_E1203: 'A function prop was interpolated as a value',
  PLAIN_E2001: 'Contract checks failed',
};

/** 返回错误码的短摘要。 */
export function summaryOf(code: PlainErrorCode, locale: PlainLocale): string {
  return locale === 'zh-CN' ? ERROR_CATALOG[code].summary : summaries[code];
}

const lintMessages = {
  signalAssignment: {
    'zh-CN': '不能直接给 signal 变量 "{name}" 赋值，要用 "{name}.set(...)"',
    en: 'Do not assign to signal "{name}" directly; use "{name}.set(...)"',
  },
  signalValue: {
    'zh-CN': 'signal 要调用取值："{{name}()}"',
    en: 'Call the signal to read its value: "{{name}()}"',
  },
  signalAttribute: {
    'zh-CN': '属性里的 signal 要调用取值："{{name}()}"',
    en: 'Call the signal in the attribute to read its value: "{{name}()}"',
  },
  reactAttribute: {
    'zh-CN': '属性名 "{name}" 是 React 拼写；规范写法是原生 HTML 名 "{renamed}"' +
      '（两者等价，check 会自动改写）',
    en: 'Attribute "{name}" uses React spelling; prefer the native HTML name "{renamed}" ' +
      '(both are equivalent; check rewrites it automatically)',
  },
  reactHook: {
    'zh-CN': 'Plain 没有 {name}：状态用 signal()，副作用用 effect()，派生值用 computed()',
    en: 'Plain has no {name}: use signal() for state, effect() for side effects, ' +
      'and computed() for derived values',
  },
  unsafeHtml: {
    'zh-CN': '禁止 innerHTML / insertAdjacentHTML：用 createTextNode / {expr} 插值',
    en: 'innerHTML / insertAdjacentHTML are forbidden: use createTextNode / {expr} interpolation',
  },
  destructureParameter: {
    'zh-CN': '不要解构 props：解构拿到的是此刻的值，signal 变化后不会更新。' +
      '改成 function Card(props)，再在 JSX / effect 里直接读 props.x',
    en: 'Do not destructure props: this captures the current value and will not update ' +
      'when signals change. Use function Card(props), then read props.x directly in JSX / effect',
  },
  destructureChain: {
    'zh-CN': '不要解构 props：解构拿到的是此刻的值，signal 变化后不会更新。' +
      '不要在组件体里先取 {access}，直接在 JSX / effect 里读它的属性',
    en: 'Do not destructure props: this captures the current value and will not update ' +
      'when signals change. Do not capture {access} in the component body; ' +
      'read its properties directly in JSX / effect',
  },
  destructureProps: {
    'zh-CN': '不要解构 props：解构拿到的是此刻的值，signal 变化后不会更新。' +
      '直接在 JSX / effect 里读 {access}.x，或写成 thunk：const x = () => {access}.x',
    en: 'Do not destructure props: this captures the current value and will not update ' +
      'when signals change. Read {access}.x directly in JSX / effect, ' +
      'or use a thunk: const x = () => {access}.x',
  },
  mutateSignal: {
    'zh-CN': '不要就地修改 signal 的值（"{expr}"，signal 是 {name}）：' +
      '请生成新值再 set，例如 {name}.set([...{name}(), x])',
    en: 'Do not mutate a signal value in place ("{expr}", signal: {name}): ' +
      'create a new value and set it, e.g. {name}.set([...{name}(), x])',
  },
  propsSnapshot: {
    'zh-CN': '不要把 props 取值快照进变量（"{name} = {access}"）：' +
      'props 是实时值，存进变量只是此刻的值，signal 变化后不会更新。' +
      '在 JSX / effect 里直接读 {access}，或写成 thunk：const {name} = () => {access}',
    en: 'Do not snapshot a prop value in a variable ("{name} = {access}"): ' +
      'props are live values; a variable only captures the current value and will not update ' +
      'when signals change. Read {access} directly in JSX / effect, ' +
      'or use a thunk: const {name} = () => {access}',
  },
  derivedSnapshot: {
    'zh-CN': '不要把 props / signal 的复合读取存进变量（"{name} = {expr}"）：' +
      '组件体只执行一次，这里得到的是挂载时的快照，依赖变化后不会更新。' +
      '把读取放进 JSX / effect，派生值用 computed(() => …)，或写成 thunk：' +
      'const {name} = () => ({expr})',
    en: 'Do not store a derived props / signal read in a variable ("{name} = {expr}"): ' +
      'the component body runs once, so this captures a mount-time snapshot that will not ' +
      'update when dependencies change. Read in JSX / effect, use computed(() => …) ' +
      'for derived values, or use a thunk: const {name} = () => ({expr})',
  },
  childrenValue: {
    'zh-CN': '不要把函数型 prop 当值插值（"{expr}" 会渲染函数源码）：' +
      'children 是 lazy subtree，写成 {{expr}()}',
    en: 'Do not interpolate a function prop as a value ("{expr}" would render its source): ' +
      'children is a lazy subtree; use {{expr}()}',
  },
  functionValue: {
    'zh-CN': '不要把函数型 prop 当值插值（"{expr}" 会渲染函数源码）：按函数调用：{{expr}(…)}',
    en: 'Do not interpolate a function prop as a value ("{expr}" would render its source): ' +
      'call it as a function: {{expr}(…)}',
  },
  contextGetter: {
    'zh-CN': 'useContext 的返回值是 getter，要先调用再取属性（"{expr}" 会取到函数自身的成员）。' +
      '改成 {target}(){suffix}',
    en: 'useContext returns a getter; call it before reading a property ' +
      '("{expr}" reads a member of the function itself). Use {target}(){suffix}',
  },
  asyncEffect: {
    'zh-CN': '不要在 effect 里用 async：依赖收集在第一个 await 之后就失效了' +
      '（后续读到的 signal 不会订阅）。把 await 提到 effect 外，或用 resource(() => …) 承载异步',
    en: 'Do not use async in effect: dependency tracking stops after the first await ' +
      '(signals read later are not subscribed). Move await outside effect, ' +
      'or use resource(() => …) for asynchronous work',
  },
  effectLoop: {
    'zh-CN': 'effect 里把 "{name}()" 读出来又写回 "{name}"，会自触发死循环：' +
      '派生值用 computed(() => …)，或在 effect 里只写「没读过」的 signal',
    en: 'Reading "{name}()" and writing back to "{name}" in effect creates an infinite ' +
      'self-triggering loop: use computed(() => …) for derived values, ' +
      'or only write signals that the effect does not read',
  },
  computedWrite: {
    'zh-CN': 'computed 里不要写 signal（"{name}.set(…)"）：派生值必须是纯函数，副作用放 effect 里',
    en: 'Do not write a signal in computed ("{name}.set(…)"): ' +
      'derived values must be pure; put side effects in effect',
  },
  moduleResource: {
    'zh-CN': '不要在模块作用域创建 resource()：它内部是 effect，会在模块被 import 时立刻执行' +
      '（App 还没挂载、SSR 导入模块时就会发请求），而且没有 owner 可回收。' +
      '把 resource() 放进组件函数体，或放进 createScope(() => …) 里',
    en: 'Do not create resource() at module scope: it contains an effect that runs as soon ' +
      'as the module is imported (before App mounts, including requests during SSR imports), ' +
      'and has no owner for cleanup. Move resource() into a component body ' +
      'or createScope(() => …)',
  },
  forwardReference: {
    'zh-CN': '顶层 {name} 创建即求值，但引用了后面才声明的 {shown}。' +
      '把 {shown} 的声明挪到这个调用之前（const 有暂时性死区，import 时就会抛 ' +
      'ReferenceError: Cannot access \'…\' before initialization）',
    en: 'Top-level {name} evaluates immediately but references later declarations: {shown}. ' +
      'Move the declarations of {shown} before this call (const has a temporal dead zone; ' +
      'importing throws ReferenceError: Cannot access \'…\' before initialization)',
  },
} satisfies Record<string, Record<PlainLocale, string>>;

export type LintMessageId = keyof typeof lintMessages;

/** 规则提供的结构化消息，参数保留原始源码文本。 */
export interface LintMessage {
  messageId: LintMessageId;
  params?: Record<string, string>;
}

/** 按语言渲染模板，仅替换已提供参数，避免改动源码中的占位符。 */
export function renderLintMessage(message: LintMessage, locale: PlainLocale): string {
  return lintMessages[message.messageId][locale].replace(/\{(\w+)\}/g, (match, key) =>
    message.params?.[key] ?? match
  );
}

/** 渲染结构化诊断；旧调用者的纯文本消息原样保留，避免丢失细节。 */
export function localizeIssue(issue: LintIssue, locale: PlainLocale): string {
  return issue.messageId ? renderLintMessage({
    messageId: issue.messageId,
    params: issue.params,
  }, locale) : issue.message;
}

/** 格式化 lint 诊断。 */
export function formatLocalizedIssues(
  issues: LintIssue[],
  fileName: string,
  locale: PlainLocale
): string {
  const icon = { error: 'x', warn: '!' };
  return issues.map((issue) =>
    `  ${icon[issue.level] || '!'} ${fileName}:${issue.line}:${issue.column}  ` +
    `[${issue.code}] ${localizeIssue(issue, locale)}`
  ).join('\n');
}
