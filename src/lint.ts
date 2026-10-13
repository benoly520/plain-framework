// Plain 契约检查器：专治 AI（和人）在 Plain 里最高频的几类写法错误
// 覆盖反模式目录 1–5（可自动修其中一部分）、7、9、11–13
//
// 设计取向：能自动修的就别只报错。所有 fix 都是 AST 定位 + 源码切片，
// 不做正则瞎替换，所以不会误伤多行声明。

import ts from "typescript";

export interface LintIssue {
  line: number;
  column: number;
  level: "error" | "warn";
  code: string;
  message: string;
  fix?: { start: number; end: number; text: string };
}

/**
 * 抑制指令：行级，和 CLI 报出来的行号一一对应。
 *   count = 1;                                   // plain-ignore-line plain/signal-assign
 *   // plain-ignore-next-line
 *   effect(() => count.set(count() + 1));
 * 不写规则码时抑制该行全部 lint 规则（多码用空格分隔）。
 * 只对 lint 规则生效 —— 编译器的 PLAIN_E* 是硬错（产物必坏），不接受抑制。
 */
const DIRECTIVE_TEXT = /^\s*plain-ignore-(next-line|line)\b([^\n]*)/;

/**
 * 行号（1-based）-> 该行允许抑制的规则码；Set 为空表示「全部」。
 * 用 TS scanner 只扫真注释，且要求指令**出现在注释开头**：
 * 于是字符串里的示例、以及文档注释中间引用的写法，都不会被误当成指令
 * （否则本文件自己的注释就能把规则静音，抑制计数也会被算脏）。
 */
export function collectIgnores(source: string): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source
  );
  let line = 1;
  let scanned = 0;
  // 注释按位置升序出现，扫过去数换行即可拿到行号（O(n)）
  const lineOf = (pos: number) => {
    for (let i = scanned; i < pos; i++) {
      if (source.charCodeAt(i) === 10) line++;
    }
    scanned = pos;
    return line;
  };
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    const multi = kind === ts.SyntaxKind.MultiLineCommentTrivia;
    if (!multi && kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    const from = lineOf(start);
    const inner = source.slice(start + 2, multi ? end - 2 : end);
    const m = inner.match(DIRECTIVE_TEXT);
    if (!m) continue;
    const codes = (m[2] || "").match(/plain\/[a-z-]+/g) || [];
    const newlines = (inner.match(/\n/g) || []).length;
    const target = m[1] === "next-line" ? from + newlines + 1 : from;
    map.set(target, new Set(codes));
  }
  return map;
}

/** 这份源码里有多少行挂了抑制指令（给 CLI 报告用：抑制不该是隐形的） */
export function suppressionCount(source: string): number {
  return collectIgnores(source).size;
}

/**
 * check(source, fileName) -> [{ line, level, code, message, fix? }]
 * fix: { start, end, text } —— 可直接作用于源码的替换
 */
export function check(
  source: string,
  fileName = "module.tsx",
  kind: ts.ScriptKind = isTsx(fileName)
): LintIssue[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind
  );
  const issues: LintIssue[] = [];
  const signals = collectSignals(sf);
  // 反模式 7 与「signal 读取结果存进变量」的交叉点：先存后改也要拦
  const aliases = collectSignalAliases(sf, signals);
  const ignores = collectIgnores(source);
  const add = (node: ts.Node, level: "error" | "warn", code: string, message: string, fix?: { start: number; end: number; text: string }) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(
      node.getStart(sf)
    );
    // 抑制指令按「报错行」匹配：CLI 打印的行号可以直接复制粘贴成指令所在行
    const allow = ignores.get(line + 1);
    if (allow && (allow.size === 0 || allow.has(code))) return;
    issues.push({
      line: line + 1,
      column: character + 1,
      level,
      code,
      message,
      fix,
    });
  };

  const visit = (node: ts.Node) => {
    // 反模式 1：给 signal 变量直接赋值：count = count() + 1
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      signals.has(node.left.text) &&
      !isDeclarationName(node.left) &&
      !isPropertyAccessTarget(node.left)
    ) {
      add(
        node,
        "error",
        "plain/signal-assign",
        `不能直接给 signal 变量 "${node.left.text}" 赋值，要用 "${node.left.text}.set(...)"`,
        {
          start: node.getStart(sf),
          end: node.getEnd(),
          text: `${node.left.text}.set(${node.right.getText(sf)})`,
        }
      );
    }

    // 反模式 2（插值分支）：JSX 里把 signal 当值用：<p>{count}</p>
    // 注意：属性值 checked={done} 的 JsxExpression 也满足下面的条件，
    // 但那条由下面的「属性分支」负责。这里必须排除，否则同一个标识符会被报两次，
    // 且两条 fix 覆盖同一区间，autofix 会把源码改成 done()() 形式的坏代码。
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isIdentifier(node.expression) &&
      signals.has(node.expression.text) &&
      !isDeclarationName(node.expression) &&
      !(node.parent && ts.isJsxAttribute(node.parent))
    ) {
      add(
        node,
        "error",
        "plain/signal-not-called",
        `signal 要调用取值："{${node.expression.text}()}"`,
        {
          start: node.expression.getStart(sf),
          end: node.expression.getEnd(),
          text: `${node.expression.text}()`,
        }
      );
    }

    // 反模式 2（属性分支）同理：JSX 属性里漏调用 signal：checked={done}
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isIdentifier(node.initializer.expression) &&
      signals.has(node.initializer.expression.text) &&
      !isDeclarationName(node.initializer.expression)
    ) {
      const id = node.initializer.expression;
      add(
        node,
        "error",
        "plain/signal-not-called",
        `属性里的 signal 要调用取值："{${id.text}()}"`,
        {
          start: id.getStart(sf),
          end: id.getEnd(),
          text: `${id.text}()`,
        }
      );
    }

    // 反模式 3：React 肌肉记忆
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const n = node.expression.text;
      if (["useState", "useEffect", "useMemo", "useCallback", "useRef"].includes(n)) {
        add(
          node,
          "error",
          "plain/react-habit",
          `Plain 没有 ${n}：状态用 signal()，副作用用 effect()，派生值用 computed()`
        );
      }
    }

    // 反模式 4：innerHTML / outerHTML —— 框架的安全红线
    if (
      (ts.isPropertyAccessExpression(node) &&
        ["innerHTML", "outerHTML"].includes(node.name.text)) ||
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "insertAdjacentHTML")
    ) {
      add(
        node,
        "error",
        "plain/no-inner-html",
        "禁止 innerHTML / insertAdjacentHTML：用 createTextNode / {expr} 插值"
      );
    }

    // 反模式 5：解构 props —— 动态属性在编译器里是 getter，解构拿到的是函数本身，
    //    响应性会静默丢失（这是 AI 从 React/Solid 带过来的头号反模式）
    //    三种口径：const {x} = props / const {x} = props.data / function Card({x})
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isObjectBindingPattern(node.name) &&
      isComponentPropsBinding(node)
    ) {
      add(node, "error", "plain/no-props-destructure", propsDestructureMessage(node));
    }

    // 反模式 7：对 signal 持有值就地改：items().push(x) / items()[0] = x
    //    深层路径也算：todos()[0].done = true / user().profile.name = "x"
    //    signal 用 Object.is 比较，就地改不会触发更新 —— 静默失败。
    if (isMutatingSignalCall(node, signals, aliases)) {
      const name = signalReadName(node, signals, aliases);
      add(
        node,
        "error",
        "plain/no-signal-mutate",
        `不要就地修改 signal 的值（"${node.getText(sf)}"，signal 是 ${name}）：` +
          `请生成新值再 set，例如 ${name}.set([...${name}(), x])`
      );
    }

    // 反模式 9：把 props 的 getter 存进变量 / 忘了 resolve
    //    const t = props.title            —— 拿到函数本身
    //    const t = resolve(props.title)   —— 初次对、之后不更新（快照）
    //    let t; t = props.title           —— 赋值形态同理（见下面第二条）
    //    {props.title} / title={props.title} —— JSX 里忘了 resolve
    //    正确：在会重跑的上下文里 resolve，或写成 thunk。
    //    on* 事件 prop 编译器不包 getter（存进变量、透传都合法），一律不报。
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isPropsSnapshotExpr(node.initializer) &&
      !isThunk(node.initializer) &&
      !isEventPropsAccess(node.initializer)
    ) {
      add(
        node,
        "error",
        "plain/no-props-snapshot",
        snapshotMessage(node.name.text, propsAccessText(node.initializer))
      );
    }

    // 反模式 9（赋值形态）：let t; t = props.title
    //    只报「直接写在组件函数体里」的赋值 —— 写在 effect / 事件回调里的赋值
    //    会随依赖重跑，属于正确用法，不报。
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      !signals.has(node.left.text) &&
      isPropsSnapshotExpr(node.right) &&
      !isEventPropsAccess(node.right) &&
      isDirectlyInComponentBody(node)
    ) {
      add(
        node,
        "error",
        "plain/no-props-snapshot",
        snapshotMessage(node.left.text, propsAccessText(node.right))
      );
    }

    // 反模式 9（JSX 形态）：JSX 里忘了 resolve
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      isPropsChain(node.expression) &&
      !(
        node.parent &&
        ts.isJsxAttribute(node.parent) &&
        isEventAttrName(jsxAttrName(node.parent))
      )
    ) {
      const access = propsAccessText(node.expression);
      add(
        node,
        "error",
        "plain/no-props-snapshot",
        `JSX 里的动态 props 要用 resolve："{resolve(${access})}"（直接写 {${access}} 拿到的是 getter 本身）`
      );
    }

    // 反模式 11：effect(async () => …) —— await 之后依赖收集失效，静默不更新
    const effectCb = callbackOf(node, "effect");
    if (effectCb && isAsyncFn(effectCb)) {
      add(
        node,
        "error",
        "plain/no-async-effect",
        "不要在 effect 里用 async：依赖收集在第一个 await 之后就失效了（后续读到的 signal 不会订阅）。" +
          "把 await 提到 effect 外，或用 resource(() => …) 承载异步"
      );
    }

    // 反模式 12：effect 里 s.set(… s() …) —— 写进去的值又读了同一个 signal，必然自触发
    if (effectCb) {
      const loop = findEffectSelfTrigger(effectCb, signals);
      if (loop) {
        add(
          node,
          "error",
          "plain/no-effect-loop",
          `effect 里把 "${loop}()" 读出来又写回 "${loop}"，会自触发死循环：` +
            `派生值用 computed(() => …)，或在 effect 里只写「没读过」的 signal`
        );
      }
    }

    // 反模式 13：computed 里写 signal —— 派生值必须是纯的
    const computedCb = callbackOf(node, "computed");
    if (computedCb) {
      const written = findSignalWrite(computedCb, signals);
      if (written) {
        add(
          node,
          "error",
          "plain/no-computed-side-effect",
          `computed 里不要写 signal（"${written}.set(…)"）：派生值必须是纯函数，副作用放 effect 里`
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return issues.sort((a, b) => a.line - b.line);
}

/** 应用所有可自动修复的问题 */
export function autofix(source: string, issues: LintIssue[]): string {
  const fixes = issues.filter((i) => i.fix).map((i) => i.fix!);
  if (!fixes.length) return source;
  // 从后往前替换。若两个 fix 的区间有重叠，第二个（更靠前的那个）必须丢弃 ——
  // 否则它的偏移量已经因为前一次替换而失效，会把源码切坏。
  const sorted = [...fixes].sort((a, b) => b.start - a.start);
  let out = source;
  let lastStart = Infinity;
  for (const f of sorted) {
    if (f.end > lastStart) continue;
    out = out.slice(0, f.start) + f.text + out.slice(f.end);
    lastStart = f.start;
  }
  return out;
}

export function formatIssues(issues: LintIssue[], fileName: string): string {
  const icon = { error: "x", warn: "!" };
  return issues
    .map(
      (i) =>
        `  ${icon[i.level] || "!"} ${fileName}:${i.line}:${i.column}  [${i.code}] ${i.message}`
    )
    .join("\n");
}

// ---------------------------------------------------------------------------

function isJsxLike(n: ts.Node): boolean {
  return (
    ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)
  );
}

/** 去掉括号 / as / 非空断言，拿到真实表达式 */
function unwrapExpr(n: ts.Node): ts.Node {
  let e: ts.Node = n;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function isThunk(n: ts.Node): boolean {
  const e = unwrapExpr(n);
  return ts.isArrowFunction(e) || ts.isFunctionExpression(e);
}

function isEventAttrName(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

function jsxAttrName(attr: ts.JsxAttribute): string {
  return ts.isIdentifier(attr.name) ? attr.name.text : attr.name.getText();
}

/** 表达式是否从组件 props 出发的属性读取（props.title / props.params.id / props["x"]） */
function propsRoot(n: ts.Node): ts.Identifier | null {
  let e: ts.Node = unwrapExpr(n);
  while (
    ts.isPropertyAccessExpression(e) ||
    ts.isElementAccessExpression(e)
  ) {
    e = unwrapExpr(e.expression);
  }
  return ts.isIdentifier(e) ? e : null;
}

function isPropsChain(n: ts.Node): boolean {
  const e = unwrapExpr(n);
  if (!(ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))) {
    return false;
  }
  const root = propsRoot(e);
  return !!root && isComponentPropsParam(root);
}

function isResolveCall(n: ts.Node): boolean {
  const e = unwrapExpr(n);
  return (
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "resolve" &&
    e.arguments.length >= 1
  );
}

/** const t = props.title  或  const t = resolve(props.title) */
function isPropsSnapshotExpr(n: ts.Node): boolean {
  if (isPropsChain(n)) return true;
  const e = unwrapExpr(n);
  if (isResolveCall(e) && ts.isCallExpression(e)) {
    return isPropsChain(e.arguments[0]);
  }
  return false;
}

function propsAccessText(n: ts.Node): string {
  const e = unwrapExpr(n);
  if (isResolveCall(e) && ts.isCallExpression(e)) {
    return unwrapExpr(e.arguments[0]).getText();
  }
  return e.getText();
}

/** 把 props 取值快照进变量时的统一提示（声明形态 / 赋值形态共用） */
function snapshotMessage(name: string, access: string): string {
  return (
    `不要把 props 取值快照进变量（"${name} = ${access}"）：` +
    `动态属性是 getter，这样会丢掉响应性。` +
    `在 JSX / effect 里写 resolve(${access})，或写成 thunk：const ${name} = () => resolve(${access})`
  );
}

/**
 * 取「直接挂在 props 上的第一个属性名」：props.onClick / props["onClick"] -> "onClick"。
 * 动态下标（props[key]）看不出来，返回 null —— 不猜，也就不按事件 prop 放行。
 */
function propsHeadPropName(n: ts.Node): string | null {
  let e: ts.Node = unwrapExpr(n);
  let head: string | null = null;
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    if (ts.isPropertyAccessExpression(e)) head = e.name.text;
    else if (ts.isStringLiteralLike(e.argumentExpression)) head = e.argumentExpression.text;
    else return null;
    e = unwrapExpr(e.expression);
  }
  return head;
}

/**
 * 取值是否来自「编译器不包 getter」的 on* 事件 prop（props.onClick / resolve(props.onClick)）。
 * 这类 prop 存的本来就是函数，快照不会丢响应性 —— 按反模式 9 报就是误报。
 */
function isEventPropsAccess(n: ts.Node): boolean {
  const e = unwrapExpr(n);
  const target = isResolveCall(e) && ts.isCallExpression(e) ? e.arguments[0] : e;
  const name = propsHeadPropName(target);
  return !!name && isEventAttrName(name);
}

/**
 * 是否直接写在组件函数体里（中间不隔着 effect / 事件回调等会重跑的上下文）。
 * 只有这种位置的赋值才是「快照」；写在回调里的赋值会随依赖重跑，属正确用法。
 */
function isDirectlyInComponentBody(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionLike(cur)) return isComponentFn(cur);
    cur = cur.parent;
  }
  return false;
}

const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "splice",
  "shift",
  "unshift",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

/** 表达式是否就是一次 signal 读取调用（items()）；是则返回 signal 名 */
function signalReadCallName(n: ts.Node, signals: Set<string>): string | null {
  const e = unwrapExpr(n);
  return ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    signals.has(e.expression.text)
    ? e.expression.text
    : null;
}

/**
 * 收集「signal 读取结果存进变量」的别名：const arr = items()。
 * 按所属函数作用域分组 —— 不同函数里的同名变量互不干扰。
 * 只认「初始值就是一次 signal 读取」（const c = items().slice() 是副本，不算）。
 */
function collectSignalAliases(
  sf: ts.SourceFile,
  signals: Set<string>
): Map<ts.Node, Map<string, string>> {
  const byScope = new Map<ts.Node, Map<string, string>>();
  const visit = (node: ts.Node, scope: ts.Node) => {
    if (ts.isFunctionLike(node)) scope = node;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const signal = signalReadCallName(node.initializer, signals);
      if (signal) {
        const m = byScope.get(scope) || new Map<string, string>();
        m.set(node.name.text, signal);
        byScope.set(scope, m);
      }
    }
    ts.forEachChild(node, (c) => visit(c, scope));
  };
  visit(sf, sf);
  return byScope;
}

/** 该位置能否把标识符解析成别名（就近的函数作用域）；能则返回它指向的 signal 名 */
function aliasSignalName(
  id: ts.Identifier,
  aliases: Map<ts.Node, Map<string, string>>
): string | null {
  let cur: ts.Node | undefined = id;
  while (cur) {
    if (ts.isFunctionLike(cur) || ts.isSourceFile(cur)) {
      return aliases.get(cur)?.get(id.text) ?? null;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * 沿「属性 / 下标访问链」向下找基座，基座是一次 signal 读取（或它的别名）就返回 signal 名：
 *   items()            -> "items"
 *   items()[0].done    -> "items"
 *   arr.push(x)        -> "items"（arr 来自 const arr = items()）
 *   items().filter(f)  -> null（filter 返回新数组，改它不脏）
 * 反模式 7 靠它覆盖深层写入：todos()[0].done = true / user().profile.name = "x"。
 */
function signalBaseName(
  n: ts.Node,
  signals: Set<string>,
  aliases: Map<ts.Node, Map<string, string>>
): string | null {
  const e = unwrapExpr(n);
  const direct = signalReadCallName(e, signals);
  if (direct) return direct;
  if (ts.isIdentifier(e)) return aliasSignalName(e, aliases);
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    return signalBaseName(e.expression, signals, aliases);
  }
  return null;
}

/** 报错文案里的 signal 名（items().push(x) / todos()[0].done = 1 → "todos"） */
function signalReadName(
  n: ts.Node,
  signals: Set<string>,
  aliases: Map<ts.Node, Map<string, string>>
): string {
  const target =
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      ? n.expression.expression
      : ts.isBinaryExpression(n)
      ? n.left
      : n;
  return signalBaseName(target, signals, aliases) || "signal";
}

/** items().push(x) / todos()[0].done = true / arr.push(x)（arr = items()） */
function isMutatingSignalCall(
  node: ts.Node,
  signals: Set<string>,
  aliases: Map<ts.Node, Map<string, string>>
): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if (!MUTATING_METHODS.has(method)) return false;
    return !!signalBaseName(node.expression.expression, signals, aliases);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const left = unwrapExpr(node.left);
    if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
      return !!signalBaseName(left.expression, signals, aliases);
    }
  }
  return false;
}

/** name(fn) 且第一个参数是函数字面量时返回该回调；函数在别处定义的看不出来 —— 不猜 */
function callbackOf(node: ts.Node, name: string): any | null {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== name) return null;
  const first = node.arguments[0];
  return first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))
    ? first
    : null;
}

function isAsyncFn(fn: any): boolean {
  return !!fn.modifiers?.some(
    (m: any) => m.kind === ts.SyntaxKind.AsyncKeyword
  );
}

/** 表达式里是否读了指定 signal（s()）；不进入嵌套函数（那里的读不在本次执行中） */
function containsSignalRead(n: ts.Node, name: string, signals: Set<string>): boolean {
  let hit = false;
  const walk = (node: ts.Node) => {
    if (hit || ts.isFunctionLike(node)) return;
    if (signalReadCallName(node, signals) === name) hit = true;
    ts.forEachChild(node, walk);
  };
  walk(n);
  return hit;
}

/** 隔着条件 / 循环就说明这次写入有闸门（钳位写法会在第二轮收敛，不算死循环） */
const GUARD_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);

/** 从 node 向上走到 stop（回调体）之间，是否隔着条件 / 循环 */
function isGuardedByCondition(node: ts.Node, stop: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur && cur !== stop) {
    if (GUARD_KINDS.has(cur.kind)) return true;
    cur = cur.parent;
  }
  return false;
}

/** 回调体里「初始化时读了 name」的局部变量名（一层中转：const n = c() + 1） */
function collectLocalDerived(
  body: ts.Node,
  name: string,
  signals: Set<string>
): Set<string> {
  const names = new Set<string>();
  const walk = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      containsSignalRead(n.initializer, name, signals)
    ) {
      names.add(n.name.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return names;
}

/** 表达式里是否引用了这些本地名字（不进入嵌套函数，一层足够） */
function referencesAny(n: ts.Node, names: Set<string>): boolean {
  if (!names.size) return false;
  let hit = false;
  const walk = (node: ts.Node) => {
    if (hit || ts.isFunctionLike(node)) return;
    if (ts.isIdentifier(node) && names.has(node.text)) hit = true;
    ts.forEachChild(node, walk);
  };
  walk(n);
  return hit;
}

/**
 * effect 回调里有没有「把 s 读出来又写回 s」—— 这类自触发是同步递归，直接
 * RangeError: Maximum call stack size exceeded，比运行时死循环保护还难读。
 * 只报没有条件闸门的写法：
 *   effect(() => count.set(count() + 1))          → 报
 *   effect(() => items.set([...items(), x]))      → 报
 *   effect(() => { if (c() > 10) c.set(0) })      → 不报（钳位第二轮就收敛）
 * 允许一层本地中转：const n = c(); c.set(n + 1) 同样报。
 */
function findEffectSelfTrigger(fn: any, signals: Set<string>): string | null {
  const body = fn.body;
  if (!body) return null;
  let found: string | null = null;
  const walk = (n: any) => {
    if (found || ts.isFunctionLike(n)) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "set" &&
      ts.isIdentifier(n.expression.expression) &&
      signals.has(n.expression.expression.text)
    ) {
      const name = n.expression.expression.text;
      const locals = collectLocalDerived(body, name, signals);
      const selfWritten = n.arguments.some(
        (a: any) =>
          containsSignalRead(a, name, signals) || referencesAny(a, locals)
      );
      if (selfWritten && !isGuardedByCondition(n, body)) found = name;
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return found;
}

/** 回调体里写了哪个 signal（s.set(…)）；不进入嵌套函数 */
function findSignalWrite(fn: any, signals: Set<string>): string | null {
  let found: string | null = null;
  const walk = (n: any) => {
    if (found || ts.isFunctionLike(n)) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "set" &&
      ts.isIdentifier(n.expression.expression) &&
      signals.has(n.expression.expression.text)
    ) {
      found = n.expression.expression.text;
    }
    ts.forEachChild(n, walk);
  };
  if (fn.body) walk(fn.body);
  return found;
}

/** 函数体是否会返回 JSX（口径与 compiler/schema.ts 保持一致） */
function returnsJsx(fn: any): boolean {
  const body = fn.body;
  if (!body) return false;
  if (isJsxLike(unwrapExpr(body))) return true;
  if (ts.isBlock(body)) {
    return body.statements.some(
      (s) =>
        ts.isReturnStatement(s) &&
        !!s.expression &&
        isJsxLike(unwrapExpr(s.expression))
    );
  }
  return false;
}

/** props 本身，或从 props 出发的属性读取（resolve(...) 包住的是正确写法，不算） */
function isPropsValueExpr(n: ts.Node): boolean {
  const e = unwrapExpr(n);
  if (ts.isIdentifier(e)) return isComponentPropsParam(e);
  return isPropsChain(e);
}

/**
 * 该解构模式是否在拆组件 props：
 *   const { x } = props      / const { x } = props.data
 *   function Card({ x }) { } / const Row = ({ x }) => <li />
 */
function isComponentPropsBinding(
  node: ts.VariableDeclaration | ts.ParameterDeclaration
): boolean {
  if (ts.isParameter(node)) {
    const fn: any = node.parent;
    return (
      ts.isFunctionLike(fn) && fn.parameters[0] === node && isComponentFn(fn)
    );
  }
  return !!node.initializer && isPropsValueExpr(node.initializer);
}

/** 反模式 5 的提示：参数解构、props 链解构、裸 props 解构的改法各不相同 */
function propsDestructureMessage(
  node: ts.VariableDeclaration | ts.ParameterDeclaration
): string {
  const head = "不要解构 props：动态属性是 getter，解构会拿到函数本身并丢失响应性。";
  if (ts.isParameter(node)) {
    return (
      head +
      `改成 function Card(props)，再在会重跑的上下文里写 resolve(props.x)`
    );
  }
  const init = unwrapExpr(node.initializer!);
  if (isPropsChain(init)) {
    return head + `先 resolve(${init.getText()})，再取它的属性`;
  }
  const p = init.getText();
  return (
    head +
    `用 resolve(${p}.x) 取值，或写成 thunk：const x = () => resolve(${p}.x)`
  );
}

/** 与编译器口径一致：这个函数会不会被当成组件（排除 map/resource 之类的回调参数） */
function isComponentFn(fn: any): boolean {
  const asArg =
    fn.parent &&
    ts.isCallExpression(fn.parent) &&
    fn.parent.arguments.indexOf(fn) >= 0;
  if (asArg) return false;
  let cur: ts.Node | undefined = fn.parent;
  while (cur) {
    if (isJsxLike(cur)) return false;
    cur = cur.parent;
  }
  return returnsJsx(fn);
}

/** id 是否是「组件的第一个参数」——也就是 props */
function isComponentPropsParam(id: ts.Identifier): boolean {
  let cur: ts.Node | undefined = id.parent;
  while (cur) {
    if (ts.isFunctionLike(cur)) {
      const first = (cur as any).parameters[0];
      return (
        !!first &&
        ts.isIdentifier(first.name) &&
        first.name.text === id.text &&
        isComponentFn(cur)
      );
    }
    cur = cur.parent;
  }
  return false;
}

function isTsx(name: string): ts.ScriptKind {
  return /\.tsx$/.test(name)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(name)
    ? ts.ScriptKind.JSX
    : /\.ts$/.test(name)
    ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
}

function collectSignals(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      ["signal", "computed", "resource"].includes(
        node.initializer.expression.text
      )
    ) {
      names.add(node.name.text);
    }
    // const { data, loading } = resource(...)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "resource"
    ) {
      node.name.elements.forEach((e) => {
        if (ts.isIdentifier(e.name)) names.add(e.name.text);
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function isDeclarationName(id: ts.Identifier): boolean {
  let cur: ts.Node | undefined = id.parent;
  while (cur) {
    if (ts.isVariableDeclaration(cur) && cur.name === id) return true;
    if (
      (ts.isVariableDeclaration(cur) ||
        ts.isPropertyAssignment(cur) ||
        ts.isParameter(cur)) &&
      cur.name === id
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function isPropertyAccessTarget(id: ts.Identifier): boolean {
  return id.parent && ts.isPropertyAccessExpression(id.parent) && id.parent.expression === id;
}
