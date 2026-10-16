// Plain 契约检查器：专治 AI（和人）在 Plain 里最高频的几类写法错误
// 覆盖反模式目录 1–5（可自动修其中一部分）、7、9、11–14、22
//
// 设计取向：能自动修的就别只报错。所有 fix 都是 AST 定位 + 源码切片，
// 不做正则瞎替换，所以不会误伤多行声明。
//
// 级别：`error` 是闸门（vite 插件默认据此让构建失败）；`warn` 只提示 + 自动改写。
// 目前唯一的 warn 规则是 PLAIN_E1115（React 拼写的属性名）——它与规范写法**等价**，
// 报成 error 会因为「写法偏好」把构建搞挂，明显过头。

import ts from "typescript";
import {
  isSuppressed,
  parseSuppressionCodes,
  type PlainErrorCode,
} from "./errors.js";
// React 拼写的兼容面（className / htmlFor）—— 与编译器用的是**同一张表**，
// 于是「收下兼容拼写」与「提示改回规范名」不会各写各的（见 src/attrs.ts）。
import { REACT_COMPAT_ALIASES } from "./attrs.js";

export interface LintIssue {
  line: number;
  column: number;
  level: "error" | "warn";
  /** 统一错误码，如 `PLAIN_E1107`；与编译器 / 构建期码同一套编号 */
  code: PlainErrorCode;
  message: string;
  fix?: { start: number; end: number; text: string };
}

/** check() 内部登记问题的回调（供各条规则复用） */
type AddIssue = (
  node: ts.Node,
  level: "error" | "warn",
  code: PlainErrorCode,
  message: string,
  fix?: { start: number; end: number; text: string }
) => void;

/**
 * 抑制指令：行级，和 CLI 报出来的行号一一对应。
 *   count = 1;                                   // plain-ignore-line PLAIN_E1101
 *   // plain-ignore-next-line
 *   effect(() => count.set(count() + 1));
 * 不写规则码时抑制该行全部 lint 规则（多码用空格分隔）。
 * 规则码既可写新码 `PLAIN_E1107`，也可写旧名 `plain/no-props-snapshot`（向后兼容）。
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
    const codes = parseSuppressionCodes(m[2] || "");
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
  // 反模式 20：const x = useContext(Ctx) —— x 是 getter，直接取属性会静默取到函数成员
  const ctxGetters = collectContextGetters(sf);
  const ignores = collectIgnores(source);
  const add = (node: ts.Node, level: "error" | "warn", code: PlainErrorCode, message: string, fix?: { start: number; end: number; text: string }) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(
      node.getStart(sf)
    );
    // 抑制指令按「报错行」匹配：CLI 打印的行号可以直接复制粘贴成指令所在行
    const allow = ignores.get(line + 1);
    if (allow && isSuppressed(allow, code)) return;
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
        "PLAIN_E1101",
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
        "PLAIN_E1102",
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
        "PLAIN_E1102",
        `属性里的 signal 要调用取值："{${id.text}()}"`,
        {
          start: id.getStart(sf),
          end: id.getEnd(),
          text: `${id.text}()`,
        }
      );
    }

    // 反模式 22：React 拼写的属性名（className / htmlFor）
    //    这两个与 class / for **等价**（编译器会归一，见 src/attrs.ts），所以只
    //    「提示 + 自动改写」，绝不报错 —— 它不是 bug，是拼写偏好。
    //    只在**内建元素**上生效：组件上的 className 是组件自己定的 prop 名，
    //    改掉会破坏组件契约（没有任何理由假设组件收的是 class）。
    if (ts.isJsxAttribute(node)) {
      const renamed = REACT_COMPAT_ALIASES[jsxAttrName(node)];
      if (renamed && isBuiltinTag(jsxOwnerTag(node))) {
        const name = jsxAttrName(node);
        add(
          node,
          "warn",
          "PLAIN_E1115",
          `属性名 "${name}" 是 React 拼写；规范写法是原生 HTML 名 "${renamed}"` +
            `（两者等价，check 会自动改写）`,
          {
            start: node.name.getStart(sf),
            end: node.name.getEnd(),
            text: renamed,
          }
        );
      }
    }

    // 反模式 3：React 肌肉记忆
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const n = node.expression.text;
      if (["useState", "useEffect", "useMemo", "useCallback", "useRef"].includes(n)) {
        add(
          node,
          "error",
          "PLAIN_E1103",
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
        "PLAIN_E1104",
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
      add(node, "error", "PLAIN_E1105", propsDestructureMessage(node));
    }

    // 反模式 7：对 signal 持有值就地改：items().push(x) / items()[0] = x
    //    深层路径也算：todos()[0].done = true / user().profile.name = "x"
    //    signal 用 Object.is 比较，就地改不会触发更新 —— 静默失败。
    if (isMutatingSignalCall(node, signals, aliases)) {
      const name = signalReadName(node, signals, aliases);
      add(
        node,
        "error",
        "PLAIN_E1106",
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
        "PLAIN_E1112",
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
        "PLAIN_E1112",
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
        "PLAIN_E1112",
        `JSX 里的动态 props 要用 resolve："{resolve(${access})}"（直接写 {${access}} 拿到的是 getter 本身）`
      );
    }

    // 反模式 20：对 useContext(Ctx) 的返回值直接取属性 —— 它是 getter，要先调用。
    //    const t = useContext(Ctx); t.name     -> 取到函数自身的成员（name / length …）
    //    useContext(Ctx).name                  -> 同上
    //    正确：useContext(Ctx)().name
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const target = node.expression;
      const isCtxGetter =
        (ts.isIdentifier(target) && ctxGetters.has(target.text)) ||
        (ts.isCallExpression(target) && isUseContextCall(target));
      if (isCtxGetter) {
        const suffix = ts.isPropertyAccessExpression(node)
          ? `.${node.name.text}`
          : `[${node.argumentExpression.getText(sf)}]`;
        add(
          node,
          "error",
          "PLAIN_E1114",
          `useContext 的返回值是 getter，要先调用再取属性（"${node.getText(sf)}" 会取到函数自身的成员）。` +
            `改成 ${target.getText(sf)}()${suffix}`
        );
      }
    }

    // 反模式 14：resolve on* 事件 prop —— 编译器不给 on[A-Z] 的 prop 包 getter，
    //    传进来的就是函数本身，而 resolve(fn) 会把函数「当场调用」。
    //    正确写法是直接 props.onXxx(...)。（no-props-snapshot 反而会漏放这一种，
    //    因为它把 on* prop 一律当「合法的透传」豁免了。）
    if (ts.isCallExpression(node) && isResolveCall(node) && isEventPropsAccess(node)) {
      const arg = node.arguments[0];
      add(
        node,
        "error",
        "PLAIN_E1108",
        `不要 resolve on* 事件 prop（"${node.getText(sf)}"）：` +
          `编译器不给 on[A-Z] 的 prop 包 getter，传进来的就是函数本身，` +
          `resolve(...) 会把它当场调用。直接写 ${arg.getText(sf)}(...)`,
        node.arguments.length === 1
          ? { start: node.getStart(sf), end: node.getEnd(), text: arg.getText(sf) }
          : undefined
      );
    }

    // 反模式 11：effect(async () => …) —— await 之后依赖收集失效，静默不更新
    const effectCb = callbackOf(node, "effect");
    if (effectCb && isAsyncFn(effectCb)) {
      add(
        node,
        "error",
        "PLAIN_E1109",
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
          "PLAIN_E1110",
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
          "PLAIN_E1111",
          `computed 里不要写 signal（"${written}.set(…)"）：派生值必须是纯函数，副作用放 effect 里`
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  // 反模式 19 需要「是否在函数内」的上下文，单独走一遍（口径见函数注释）
  checkModuleScopeResource(sf, add);
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

/** 属性所在元素的标签名（<div …> -> "div"；取不到返回 null） */
function jsxOwnerTag(attr: ts.JsxAttribute): string | null {
  const holder: any = attr.parent && attr.parent.parent;
  const tagName = holder && holder.tagName;
  return tagName ? tagName.getText() : null;
}

/**
 * 标签是内建元素还是组件 —— 口径与编译器一致（`src/compiler/index.ts` 的
 * `isComponentTag`）：大写开头 / 含 `.`（`Ctx.Provider`）是组件。
 */
function isBuiltinTag(tag: string | null): boolean {
  if (!tag) return false;
  return !/^[A-Z]/.test(tag) && !tag.includes(".");
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
      // useContext(Ctx) 返回的也是 getter（和 signal 同读法）—— 一并纳入，
      // 于是 {x} 会被既有的 PLAIN_E1102 自动修成 {x()}
      ["signal", "computed", "resource", "useContext"].includes(
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

/**
 * 反模式 19（异步资源生命周期）：在**模块作用域**创建 resource()。
 *
 * resource() 内部是一个 effect，放在模块作用域下它会在**模块被 import 的那一刻立刻执行**：
 *   - 立刻发起请求 —— 此时 App 还没挂载，SSR 下更是在服务端「导入模块」时就发请求；
 *   - 没有 owner，永远没人回收。
 * 正确位置：组件函数体，或 createScope(() => …) 里。
 *
 * 判定口径：resource(...) 调用到 SourceFile 之间**没有任何函数祖先**。
 * 组件、回调、createScope(() => …) 里的箭头函数都算函数祖先 —— 所以这是纯粹的语法事实，
 * 不存在误报（模块作用域的 resource 没有任何合法场景）。看不出的东西一律不猜。
 */
function checkModuleScopeResource(sf: ts.SourceFile, add: AddIssue): void {
  const walk = (node: ts.Node, inFunction: boolean) => {
    if (
      !inFunction &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "resource"
    ) {
      add(
        node,
        "error",
        "PLAIN_E1113",
        "不要在模块作用域创建 resource()：它内部是 effect，会在模块被 import 时立刻执行" +
          "（App 还没挂载、SSR 导入模块时就会发请求），而且没有 owner 可回收。" +
          "把 resource() 放进组件函数体，或放进 createScope(() => …) 里"
      );
    }
    const next = inFunction || ts.isFunctionLike(node);
    ts.forEachChild(node, (c) => walk(c, next));
  };
  walk(sf, false);
}

/** 是否为 `useContext(...)` 调用 */
function isUseContextCall(n: ts.Node): boolean {
  return (
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "useContext"
  );
}

/** 收集 `const x = useContext(Ctx)` 里的 x —— 它们是 getter，直接取属性要报 E1114 */
function collectContextGetters(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isUseContextCall(unwrapExpr(node.initializer))
    ) {
      names.add(node.name.text);
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
