// Plain 编译器：TSX(去类型后) -> 直接构建 DOM 的 JS
//
// 策略：TypeScript 解析器做结构分析 + 「源码切片替换」生成代码。
// 相比用 TS factory 构造节点，切片替换的结果完全可预测，出错也好定位行号。
//
// 三条硬约束：
//   1. 输出里不出现任何 JSX（浏览器不能直接跑 JSX）
//   2. 不生成 innerHTML / eval
//   3. 遇到不支持的 JSX 形态必须报带行号的错误，而不是静默产出坏代码

import ts from "typescript";

let uid = 0;
const fresh = (p) => `__${p}${++uid}`;

// helper 一律用别名引入，避免和用户自己的 import 重名
const E = "__effect";
const S = "__stringify";
const INS = "__insert";
const EACH = "__each";
const WHEN = "__when";
const RPC = "__rpc";

const PLACE = "__place";

const HELPER_IMPORT =
  `import { effect as ${E}, stringify as ${S}, insert as ${INS}, ` +
  `each as ${EACH}, when as ${WHEN}, rpc as ${RPC}, place as ${PLACE} } from "plain";`;

function isComponentTag(name) {
  return /^[A-Z]/.test(name) || name.includes(".");
}

function isJsxLike(n) {
  return (
    ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)
  );
}

function insideJsx(node) {
  let cur = node.parent;
  while (cur) {
    if (isJsxLike(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

function unparen(n) {
  let e = n;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/**
 * compile(source) -> { code, serverFunctions }
 * serverFunctions: [{ name, body }] —— 需物理运行在服务端并对外暴露的部分
 */
export function compile(source, fileName = "module.jsx") {
  uid = 0;
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX
  );

  const edits = [];
  const serverFunctions = [];

  const walk = (node) => {
    // 1) server(fn) -> RPC 桩 + 物理剥离
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "server" &&
      node.arguments.length > 0
    ) {
      const arg = node.arguments[0];
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
        const name = serverVarName(node);
        serverFunctions.push({ name, body: arg.getText(sf) });
        edits.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          text: `((...__args) => ${RPC}(${JSON.stringify(name)}, __args))`,
        });
      }
    }

    // 2) 组件：箭头函数简洁体 => { 生成 fragment; return fragment; }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      node.body &&
      isJsxLike(unparen(node.body)) &&
      !insideJsx(node) &&
      !isCallArgument(node)
    ) {
      edits.push({
        start: node.body.getStart(sf),
        end: node.body.getEnd(),
        text: `{\n${genBlock(unparen(node.body))}\n}`,
      });
    }

    // 3) 组件：块体内的 return <jsx/> => { ... return __f; }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      isJsxLike(unparen(node.expression)) &&
      node.parent &&
      ts.isBlock(node.parent) &&
      !insideJsx(node)
    ) {
      edits.push({
        start: node.getStart(sf),
        end: node.getEnd(),
        text: `{\n${genBlock(unparen(node.expression))}\n}`,
      });
    }

    ts.forEachChild(node, walk);
  };

  walk(sf);
  assertJsxCovered(sf, edits, fileName);

  let code = applyEdits(source, edits);
  code = `${HELPER_IMPORT}\n${code}`;
  assertClean(code, fileName);
  return { code, serverFunctions };
}

/**
 * 兜底自检：产物必须是能被普通 JS 解析器解析的干净代码，且不含任何 JSX。
 * 这一层是最后防线 —— 宁可报错，也不能把坏代码悄悄交给打包器。
 */
function assertClean(code, fileName) {
  const out = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const diags = out.parseDiagnostics || [];
  if (diags.length) {
    const d = diags[0];
    const { line } = out.getLineAndCharacterOfPosition(d.start);
    throw new Error(
      `[plain] 生成的 ${fileName} 无法解析（第 ${line + 1} 行）：` +
        `${ts.flattenDiagnosticMessageText(d.messageText, " ")}\n` +
        `  注意：compile() 的输入必须是「已剥离 TS 类型」的 JSX 代码（先用 esbuild/jsx:preserve 处理过）。`
    );
  }
  let leaked = -1;
  const scan = (n) => {
    if (isJsxLike(n) && leaked < 0) leaked = n.getStart(out);
    ts.forEachChild(n, scan);
  };
  scan(out);
  if (leaked >= 0) {
    const { line } = out.getLineAndCharacterOfPosition(leaked);
    throw new Error(
      `[plain] 生成的代码里残留 JSX（${fileName}:${line + 1}）—— 这是编译器 bug`
    );
  }
}

function isCallArgument(node) {
  return (
    node.parent &&
    ts.isCallExpression(node.parent) &&
    node.parent.arguments.indexOf(node) >= 0
  );
}

function jsxContext(node) {
  let cur = node.parent;
  while (cur) {
    if (isJsxLike(cur)) return true;
    if (
      ts.isCallExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isFunctionDeclaration(cur)
    ) {
      return false;
    }
    cur = cur.parent;
  }
  return false;
}

function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function serverVarName(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return `serverFn_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// 生成：一段能返回 Fragment 的语句
// ---------------------------------------------------------------------------

/**
 * genFragment(node, out) —— 生成「把 node 渲染进一个新建 Fragment 并返回」的语句。
 * node 可以是 JSX，也可以是条件表达式 / && 表达式 / .map 调用，任意嵌套都支持。
 */
function genFragment(node, out) {
  out.push(`const __f = document.createDocumentFragment();`);
  emitExprInto(node, "__f", out);
  out.push(`return __f;`);
  return out;
}

function genBlock(node) {
  return genFragment(node, []).join("\n");
}

/**
 * emitExprInto(node, parentVar, out)
 * 任意表达式 -> 渲染到 parentVar。这是整个编译器唯一的「发射入口」，
 * 嵌套的条件/map 都走这里递归，保证不会有 JSX 偷偷漏到输出里。
 */
function emitExprInto(node, parentVar, out) {
  // arr.map(...)
  const m = detectMap(node);
  if (m) {
    const body = [];
    genFragment(m.body, body);
    out.push(
      `${EACH}(${parentVar}, () => (${m.array}), (${m.param}${
        m.index ? `, ${m.index}` : ""
      }) => {\n${body.join("\n")}\n});`
    );
    return;
  }

  // cond ? a : b
  if (ts.isConditionalExpression(node)) {
    const cond = node.condition.getText();
    const thenOut = [];
    const elseOut = [];
    genFragment(unparen(node.whenTrue), thenOut);
    const hasElse = !!node.whenFalse;
    if (hasElse) genFragment(unparen(node.whenFalse), elseOut);
    out.push(
      `${WHEN}(${parentVar}, () => (${cond}), () => {\n${thenOut.join(
        "\n"
      )}\n}, ${hasElse ? `() => {\n${elseOut.join("\n")}\n}` : "null"});`
    );
    return;
  }

  // cond && a
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    const cond = node.left.getText();
    const thenOut = [];
    genFragment(unparen(node.right), thenOut);
    out.push(
      `${WHEN}(${parentVar}, () => (${cond}), () => {\n${thenOut.join(
        "\n"
      )}\n}, null);`
    );
    return;
  }

  if (isJsxLike(node)) {
    emitNode(node, parentVar, out);
    return;
  }

  out.push(`${INS}(${parentVar}, () => (${node.getText()}));`);
}

function tagParts(node) {
  if (ts.isJsxElement(node))
    return [
      node.openingElement.tagName.getText(),
      node.openingElement.attributes,
      node.children,
    ];
  if (ts.isJsxSelfClosingElement(node))
    return [node.tagName.getText(), node.attributes, []];
  return null;
}

function emitNode(node, parentVar, out) {
  if (!node) return;
  if (ts.isJsxFragment(node)) {
    node.children.forEach((c) => emitChild(c, parentVar, out));
    return;
  }
  const parts = tagParts(node);
  if (!parts) {
    throw new Error(`[plain] emitNode 不支持的节点 ${ts.SyntaxKind[node.kind]}`);
  }
  const [tagText, attrs, children] = parts;
  if (isComponentTag(tagText)) {
    emitComponent(tagText, attrs, children, parentVar, out);
    return;
  }
  emitElement(tagText, attrs, children, parentVar, out);
}

// --- props -----------------------------------------------------------------

function paramList(fn) {
  return fn.parameters.map((p) => p.getText()).join(", ");
}

/** 把「返回 JSX 的箭头函数」编译成正常的函数：主要出现在组件 props 里 */
function genFnWithJsxBody(fn) {
  let bodyNode = null;
  if (isJsxLike(unparen(fn.body))) bodyNode = unparen(fn.body);
  else if (ts.isBlock(fn.body)) {
    const ret = fn.body.statements.find(
      (s) => ts.isReturnStatement(s) && s.expression && isJsxLike(unparen(s.expression))
    );
    if (ret) bodyNode = unparen(ret.expression);
  }
  if (!bodyNode) return null;
  const out = [];
  emitNode(bodyNode, "__fb", out);
  return `(${paramList(fn)}) => {\nconst __fb = document.createDocumentFragment();\n${out.join(
    "\n"
  )}\nreturn __fb;\n}`;
}

function valueCode(exprNode) {
  if (ts.isArrowFunction(exprNode) || ts.isFunctionExpression(exprNode)) {
    return genFnWithJsxBody(exprNode) || exprNode.getText();
  }
  return exprNode.getText();
}

function collectProps(attrs) {
  const parts = [];
  attrs.properties.forEach((p) => {
    if (ts.isJsxAttribute(p)) {
      const raw = p.name.getText();
      const key = raw === "class" ? "className" : raw;
      const init = p.initializer;
      if (!init) {
        parts.push(`${key}: true`);
      } else if (ts.isStringLiteral(init) || ts.isNumericLiteral(init)) {
        parts.push(`${key}: ${JSON.stringify(init.text)}`);
      } else if (ts.isJsxExpression(init) && init.expression) {
        const exprNode = init.expression;
        if (/^on[A-Z]/.test(raw)) {
          parts.push(`${key}: (${valueCode(exprNode)})`);
        } else if (
          ts.isArrowFunction(exprNode) ||
          ts.isFunctionExpression(exprNode)
        ) {
          // 函数本身就是要传的值（如 fallback={(e) => ...}），不再包一层 getter
          parts.push(`${key}: ${valueCode(exprNode)}`);
        } else {
          parts.push(`${key}: () => (${exprNode.getText()})`);
        }
      }
    } else if (ts.isJsxSpreadAttribute(p)) {
      parts.push(`...(${p.expression.getText()})`);
    }
  });
  return parts;
}

function emitComponent(tagText, attrs, children, parentVar, out) {
  const propsVar = fresh("props");
  const parts = collectProps(attrs);
  const meaningful = children.filter(
    (c) => !ts.isJsxText(c) || c.text.trim() !== ""
  );
  if (meaningful.length) {
    parts.push(`children: () => { ${genChildrenBody(meaningful)} }`);
  }
  out.push(`const ${propsVar} = { ${parts.join(", ")} };`);
  out.push(`${PLACE}(${parentVar}, ${tagText}(${propsVar}));`);
}

function genChildrenBody(children) {
  const out = [];
  children.forEach((c) => emitChild(c, "__cf", out));
  return `const __cf = document.createDocumentFragment();\n${out.join(
    "\n"
  )}\nreturn __cf;`;
}

// --- 原生元素 --------------------------------------------------------------

const PROP_ALIAS = {
  for: "htmlFor",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  tabindex: "tabIndex",
  autofocus: "autofocus",
};

const DOM_PROPS = new Set([
  "value",
  "checked",
  "selected",
  "disabled",
  "multiple",
  "id",
  "type",
  "placeholder",
  "href",
  "src",
  "alt",
  "title",
  "name",
  "min",
  "max",
  "step",
  "pattern",
  "readOnly",
  "htmlFor",
  "tabIndex",
  "maxLength",
]);

function emitElement(tagText, attrs, children, parentVar, out) {
  const el = fresh("el");
  out.push(`const ${el} = document.createElement(${JSON.stringify(tagText)});`);

  attrs.properties.forEach((p) => {
    if (ts.isJsxAttribute(p)) {
      const raw = p.name.getText();
      const key = PROP_ALIAS[raw] || raw;
      const init = p.initializer;

      if (!init) {
        out.push(`${el}.setAttribute(${JSON.stringify(raw)}, "");`);
        return;
      }
      if (ts.isStringLiteral(init)) {
        if (key === "className") {
          out.push(`${el}.className = ${JSON.stringify(init.text)};`);
        } else {
          out.push(
            `${el}.setAttribute(${JSON.stringify(raw)}, ${JSON.stringify(
              init.text
            )});`
          );
        }
        return;
      }
      if (ts.isJsxExpression(init) && init.expression) {
        const expr = init.expression.getText();
        if (/^on[A-Z]/.test(raw)) {
          out.push(
            `${el}.addEventListener(${JSON.stringify(
              raw.slice(2).toLowerCase()
            )}, ${valueCode(init.expression)});`
          );
        } else if (key === "className" || raw === "class") {
          out.push(`${E}(() => { ${el}.className = ${S}(${expr}); });`);
        } else if (key === "style") {
          out.push(
            `${E}(() => { const __s = (${expr}); if (typeof __s === 'string') ${el}.setAttribute('style', __s); else Object.assign(${el}.style, __s); });`
          );
        } else if (DOM_PROPS.has(key)) {
          out.push(`${E}(() => { ${el}.${key} = (${expr}); });`);
        } else {
          out.push(
            `${E}(() => { const __v = (${expr}); if (__v === false || __v == null) ${el}.removeAttribute(${JSON.stringify(
              raw
            )}); else ${el}.setAttribute(${JSON.stringify(raw)}, ${S}(__v)); });`
          );
        }
      }
    } else if (ts.isJsxSpreadAttribute(p)) {
      const sp = fresh("sp");
      out.push(
        `const ${sp} = ${p.expression.getText()}; for (const k of Object.keys(${sp})) { const v = ${sp}[k]; if (/^on[A-Z]/.test(k)) ${el}.addEventListener(k.slice(2).toLowerCase(), v); else if (v === false || v == null) ${el}.removeAttribute(k); else ${el}.setAttribute(k, ${S}(v)); }`
      );
    }
  });

  children.forEach((c) => emitChild(c, el, out));
  out.push(`${parentVar}.appendChild(${el});`);
}

// --- children --------------------------------------------------------------

function emitChild(child, parentVar, out) {
  if (ts.isJsxText(child)) {
    if (child.text.trim() === "") return;
    out.push(
      `${parentVar}.appendChild(document.createTextNode(${JSON.stringify(
        child.text
      )}));`
    );
    return;
  }

  if (ts.isJsxExpression(child)) {
    if (child.expression) emitExprInto(child.expression, parentVar, out);
    return;
  }

  emitNode(child, parentVar, out);
}

// --- map -------------------------------------------------------------------

function detectMap(node) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "map" &&
    node.arguments.length >= 1
  ) {
    const array = node.expression.expression.getText();
    const cb = node.arguments[0];
    if (
      (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
      cb.parameters.length >= 1
    ) {
      const param = cb.parameters[0].name.getText();
      const index =
        cb.parameters.length >= 2 ? cb.parameters[1].name.getText() : null;
      const body = ts.isBlock(cb.body)
        ? (() => {
            const ret = cb.body.statements.find((s) => ts.isReturnStatement(s));
            return ret && ret.expression ? unparen(ret.expression) : null;
          })()
        : unparen(cb.body);
      if (body) return { array, param, index, body };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 兜底校验：任何没被处理到的 JSX 都不能悄悄漏出去
// ---------------------------------------------------------------------------
function assertJsxCovered(sf, edits, fileName) {
  const missing = [];
  const visit = (node) => {
    if (isJsxLike(node) && !insideJsx(node)) {
      const start = node.getStart(sf);
      const end = node.getEnd();
      const covered = edits.some((e) => e.start <= start && end <= e.end);
      if (!covered) {
        const { line } = sf.getLineAndCharacterOfPosition(start);
        missing.push(`${fileName}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (missing.length) {
    throw new Error(
      `[plain] 这些位置的 JSX 编译器还不认识：${missing.join(", ")}\n` +
        `  常见写法：组件用 'return (<jsx/>)'；列表用 'arr.map(x => <jsx/>)'；` +
        `条件用 '{cond ? <a/> : <b/>}' 或 '{cond && <a/>}'。`
    );
  }
}
