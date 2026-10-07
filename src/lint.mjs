// Plain 契约检查器：专治 AI（和人）在 Plain 里最高频的几类写法错误
//
// 设计取向：能自动修的就别只报错。所有 fix 都是 AST 定位 + 源码切片，
// 不做正则瞎替换，所以不会误伤多行声明。

import ts from "typescript";

/**
 * check(source, fileName) -> [{ line, level, code, message, fix? }]
 * fix: { start, end, text } —— 可直接作用于源码的替换
 */
export function check(source, fileName = "module.tsx", kind = isTsx(fileName)) {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind
  );
  const issues = [];
  const signals = collectSignals(sf);
  const add = (node, level, code, message, fix) => {
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

  const visit = (node) => {
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
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isIdentifier(node.expression) &&
      signals.has(node.expression.text) &&
      !isDeclarationName(node.expression)
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

    // 6) map 里没返回 JSX（编译器会拒绝，提前提示更友好）
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return issues.sort((a, b) => a.line - b.line);
}

/** 应用所有可自动修复的问题 */
export function autofix(source, issues) {
  const fixes = issues.filter((i) => i.fix).map((i) => i.fix);
  if (!fixes.length) return source;
  const sorted = [...fixes].sort((a, b) => b.start - a.start);
  let out = source;
  for (const f of sorted) out = out.slice(0, f.start) + f.text + out.slice(f.end);
  return out;
}

export function formatIssues(issues, fileName) {
  const icon = { error: "x", warn: "!" };
  return issues
    .map(
      (i) =>
        `  ${icon[i.level] || "!"} ${fileName}:${i.line}:${i.column}  [${i.code}] ${i.message}`
    )
    .join("\n");
}

// ---------------------------------------------------------------------------

function isTsx(name) {
  return /\.tsx$/.test(name)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(name)
    ? ts.ScriptKind.JSX
    : /\.ts$/.test(name)
    ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
}

function collectSignals(sf) {
  const names = new Set();
  const visit = (node) => {
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

function isDeclarationName(id) {
  let cur = id.parent;
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

function isPropertyAccessTarget(id) {
  return id.parent && ts.isPropertyAccessExpression(id.parent) && id.parent.expression === id;
}
