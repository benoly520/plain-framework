// Plain 契约检查器：专治 AI（和人）在 Plain 里最高频的几类写法错误
// 覆盖反模式目录 1–5（可自动修其中一部分）、7（就地改）、9（props 快照）
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
  const add = (node: ts.Node, level: "error" | "warn", code: string, message: string, fix?: { start: number; end: number; text: string }) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(
      node.getStart(sf)
    );
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
    // 1) 给 signal 变量直接赋值：count = count() + 1
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

    // 2) JSX 里把 signal 当值用：<p>{count}</p>
    // 注意：属性值 checked={done} 的 JsxExpression 也满足下面的条件，
    // 但那条由规则 3 负责。这里必须排除，否则同一个标识符会被报两次，
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

    // 3) JSX 属性里同理：checked={done}
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

    // 4) React 肌肉记忆
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

    // 5) innerHTML / outerHTML —— 框架的安全红线
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

    // 6) 解构 props —— 动态属性在编译器里是 getter，解构拿到的是函数本身，
    //    响应性会静默丢失（这是 AI 从 React/Solid 带过来的头号反模式）
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      isComponentPropsParam(node.initializer)
    ) {
      const p = node.initializer.text;
      add(
        node,
        "error",
        "plain/no-props-destructure",
        `不要解构 props（"… = ${p}"）：动态属性是 getter，解构会拿到函数本身并丢失响应性。` +
          `用 resolve(${p}.x) 取值，或写成 thunk：const x = () => resolve(${p}.x)`
      );
    }

    // 7) 把 props 的 getter 存进变量 / 忘了 resolve
    //    const t = props.title           —— 拿到函数本身
    //    const t = resolve(props.title)  —— 初次对、之后不更新（快照）
    //    {props.title} / title={props.title} —— JSX 里忘了 resolve
    //    正确：在会重跑的上下文里 resolve，或写成 thunk。
    //    on* 事件 prop 编译器不包 getter，透传不报。
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      !isThunk(node.initializer) &&
      isPropsSnapshotExpr(node.initializer)
    ) {
      const access = propsAccessText(node.initializer);
      add(
        node,
        "error",
        "plain/no-props-snapshot",
        `不要把 props 取值快照进变量（"${node.name.text} = ${access}"）：` +
          `动态属性是 getter，这样会丢掉响应性。` +
          `在 JSX / effect 里写 resolve(${access})，或写成 thunk：const ${node.name.text} = () => resolve(${access})`
      );
    }

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

    // 8) 对 signal 持有值就地改：items().push(x) / items()[0] = x
    //    signal 用 Object.is 比较，就地改不会触发更新 —— 静默失败。
    if (isMutatingSignalCall(node, signals)) {
      const name = signalReadName(node);
      add(
        node,
        "error",
        "plain/no-signal-mutate",
        `不要就地修改 signal 的值（"${name}().…"）：` +
          `请生成新值再 set，例如 ${name}.set([...${name}(), x])`
      );
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

function isSignalRead(n: ts.Node, signals: Set<string>): n is ts.CallExpression {
  const e = unwrapExpr(n);
  return (
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    signals.has(e.expression.text)
  );
}

function signalReadName(n: ts.Node): string {
  let e: ts.Node = unwrapExpr(n);
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression)
  ) {
    e = e.expression.expression;
  } else if (ts.isBinaryExpression(e)) {
    e = e.left;
  }
  e = unwrapExpr(e);
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    e = unwrapExpr(e.expression);
  }
  e = unwrapExpr(e);
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    return e.expression.text;
  }
  return "signal";
}

/** items().push(x) 或 items()[0] = x / items().foo = x */
function isMutatingSignalCall(node: ts.Node, signals: Set<string>): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if (!MUTATING_METHODS.has(method)) return false;
    return isSignalRead(node.expression.expression, signals);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const left = unwrapExpr(node.left);
    if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
      return isSignalRead(left.expression, signals);
    }
  }
  return false;
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
