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

/** 编译器识别出的服务端函数：{ name, body } */
export interface ServerFunction {
  name: string;
  body: string;
}

/**
 * 编译错误码 —— 机器可读，供 IDE / CI / AI 直接消费（SPEC §7「自解释错误」）。
 *
 * - `PLAIN_E1001` 有 JSX 落在编译器不认识的写法里
 * - `PLAIN_E1002` 生成的产物无法被 JS 解析（输入没先剥离 TS 类型）
 * - `PLAIN_E1003` 生成的产物里残留 JSX（编译器 bug）
 * - `PLAIN_E1004` 遇到不支持的语法节点（编译器 bug）
 * - `PLAIN_E1005` 列表元素的 key 与 index 参数同时使用（语义二选一）
 * - `PLAIN_E2001` 契约检查未通过（由构建链路抛出，见 vite 插件）
 */
export type PlainErrorCode =
  | "PLAIN_E1001"
  | "PLAIN_E1002"
  | "PLAIN_E1003"
  | "PLAIN_E1004"
  | "PLAIN_E1005"
  | "PLAIN_E2001";

export interface PlainCompileErrorInit {
  code: PlainErrorCode;
  file: string;
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
  detail: string;
  hint: string;
}

/**
 * PlainCompileError —— 编译错误的统一形态。
 * `message` 保持人类可读（含 code / 位置 / 修正提示）；
 * `code` / `file` / `line` / `column` / `hint` 供工具链结构化消费。
 */
export class PlainCompileError extends Error {
  readonly code: PlainErrorCode;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly detail: string;
  readonly hint: string;

  constructor(init: PlainCompileErrorInit) {
    super(
      `[${init.code}] ${init.file}:${init.line}:${init.column} ${init.detail}\n` +
        `  提示：${init.hint}`
    );
    this.name = "PlainCompileError";
    this.code = init.code;
    this.file = init.file;
    this.line = init.line;
    this.column = init.column;
    this.detail = init.detail;
    this.hint = init.hint;
  }

  /** 便于 JSON.stringify / 结构化日志 */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      file: this.file,
      line: this.line,
      column: this.column,
      detail: this.detail,
      hint: this.hint,
    };
  }
}

let uid = 0;
const fresh = (p: string) => `__${p}${++uid}`;

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

function isComponentTag(name: string): boolean {
  return /^[A-Z]/.test(name) || name.includes(".");
}

function isJsxLike(n: any): boolean {
  return (
    ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)
  );
}

function insideJsx(node: any): boolean {
  let cur = node.parent;
  while (cur) {
    if (isJsxLike(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

function unparen(n: any): any {
  let e = n;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** 编译产物 sourcemap（line 级） */
export interface CompileSourceMap {
  version: 3;
  file: string;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

export interface CompileOptions {
  /** sourcemap 的 sources 里写什么路径（默认与 fileName 相同；vite 插件会传真实模块路径） */
  mapSource?: string;
  /** 是否生成 sourcemap，默认 true */
  sourceMap?: boolean;
}

/**
 * compile(source, fileName, options) -> { code, serverFunctions, map }
 * serverFunctions: [{ name, body }] —— 需物理运行在服务端并对外暴露的部分
 * map: line 级 sourcemap，交给打包器链式消费（默认开启，可用 options.sourceMap 关掉）
 */
export function compile(
  source: string,
  fileName = "module.jsx",
  options: CompileOptions = {}
): { code: string; serverFunctions: ServerFunction[]; map: CompileSourceMap | null } {
  uid = 0;
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX
  );

  const edits: any[] = [];
  const serverFunctions: ServerFunction[] = [];

  const walk = (node: any) => {
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

  const applied = applyEdits(source, edits);
  const code = `${HELPER_IMPORT}\n${applied.code}`;
  assertClean(code, fileName);
  // HELPER_IMPORT 固定占 1 行，映射时要把它跳过去
  const map =
    options.sourceMap === false
      ? null
      : buildSourceMap(source, applied, 1, options.mapSource || fileName, fileName);
  return { code, serverFunctions, map };
}

/**
 * 兜底自检：产物必须是能被普通 JS 解析器解析的干净代码，且不含任何 JSX。
 * 这一层是最后防线 —— 宁可报错，也不能把坏代码悄悄交给打包器。
 */
function assertClean(code: string, fileName: string): void {
  const out = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const diags = (out as any).parseDiagnostics || [];
  if (diags.length) {
    const d = diags[0];
    const at = out.getLineAndCharacterOfPosition(d.start ?? 0);
    throw new PlainCompileError({
      code: "PLAIN_E1002",
      file: fileName,
      line: at.line + 1,
      column: at.character + 1,
      detail: `编译产物无法解析：${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
      hint:
        "compile() 的输入必须是「已剥离 TS 类型」的合法 JSX" +
        "（先用 esbuild 以 jsx: 'preserve' 处理）；若输入本身合法，请附最小复现提 issue",
    });
  }
  let leaked = -1;
  const scan = (n: any) => {
    if (isJsxLike(n) && leaked < 0) leaked = n.getStart(out);
    ts.forEachChild(n, scan);
  };
  scan(out);
  if (leaked >= 0) {
    const at = out.getLineAndCharacterOfPosition(leaked);
    throw new PlainCompileError({
      code: "PLAIN_E1003",
      file: fileName,
      line: at.line + 1,
      column: at.character + 1,
      detail: "编译产物里残留了未处理的 JSX（这是编译器 bug）",
      hint: "请附最小复现提 issue",
    });
  }
}

function isCallArgument(node: any): boolean {
  return (
    node.parent &&
    ts.isCallExpression(node.parent) &&
    node.parent.arguments.indexOf(node) >= 0
  );
}

function jsxContext(node: any): boolean {
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

/** 产物的一个区间 ← 源码的一个区间（generated 表示这段是编译器生成的） */
interface EditSegment {
  outStart: number;
  inStart: number;
  length: number;
  generated: boolean;
}

/**
 * 应用编辑，同时记录「产物区间 ← 源码区间」的对应关系。
 * 按 start 升序拼接（编译器产生的编辑之间互不重叠），
 * 因此可以顺带产出 sourcemap，见 buildSourceMap。
 */
function applyEdits(source: string, edits: any[]): { code: string; segments: EditSegment[] } {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  let code = "";
  const segments: EditSegment[] = [];
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos) continue; // 防御：与前一处编辑重叠时直接跳过，绝不产出半截代码
    if (e.start > pos) {
      const kept = source.slice(pos, e.start);
      segments.push({
        outStart: code.length,
        inStart: pos,
        length: kept.length,
        generated: false,
      });
      code += kept;
    }
    segments.push({
      outStart: code.length,
      inStart: e.start,
      length: e.text.length,
      generated: true,
    });
    code += e.text;
    pos = e.end;
  }
  if (pos < source.length) {
    const kept = source.slice(pos);
    segments.push({
      outStart: code.length,
      inStart: pos,
      length: kept.length,
      generated: false,
    });
    code += kept;
  }
  return { code, segments };
}

// ---------------------------------------------------------------------------
// sourcemap：line 级映射
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64 VLQ（sourcemap v3 的 mappings 编码） */
function vlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

/** 每一行的起始偏移（用于「偏移 <-> 行列」换算） */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 二分查找偏移所在行号 */
function lineOf(starts: number[], off: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 生成 line 级 sourcemap：
 *   - 未被改动的行：按原偏移 1:1 映射回源码（列也保留）
 *   - 编译器生成的行块：整块映射回「被替换的那段源码的起始位置」
 * 这个粒度足以让断点/堆栈落在正确的组件与语句上，且不依赖完整的位置追踪。
 */
function buildSourceMap(
  source: string,
  applied: { code: string; segments: EditSegment[] },
  prefixLines: number,
  mapSource: string,
  fileName: string
): CompileSourceMap {
  const srcStarts = lineStarts(source);
  const codeStarts = lineStarts(applied.code);
  const { segments } = applied;

  const findSegment = (off: number): EditSegment | null => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segments[mid];
      if (off < s.outStart) hi = mid - 1;
      else if (off >= s.outStart + s.length) lo = mid + 1;
      else return s;
    }
    return null;
  };

  // 前面 prefixLines 行（注入的 helper import）没有源码对应，先占位，
  // 这样 mappings 的分组数才与最终产物行数严格一致。
  const lines: string[] = new Array(prefixLines).fill("");
  let prevSrcLine = 0;
  let prevSrcCol = 0;

  for (let i = 0; i < codeStarts.length; i++) {
    const genOff = codeStarts[i];
    const seg = findSegment(genOff);
    if (!seg) {
      lines.push("");
      continue;
    }
    const srcOff = seg.generated ? seg.inStart : seg.inStart + (genOff - seg.outStart);
    const srcLine = lineOf(srcStarts, srcOff);
    const srcCol = seg.generated ? 0 : srcOff - srcStarts[srcLine];
    // 每行只发一个 segment：[genColumn, sourceIndex, srcLine, srcColumn]（相对前值）
    lines.push(vlq(0) + vlq(0) + vlq(srcLine - prevSrcLine) + vlq(srcCol - prevSrcCol));
    prevSrcLine = srcLine;
    prevSrcCol = srcCol;
  }

  return {
    version: 3,
    file: fileName,
    sources: [mapSource],
    sourcesContent: [source],
    names: [],
    mappings: lines.join(";"),
  };
}

function serverVarName(node: any): string {
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
function genFragment(node: any, out: string[]): string[] {
  out.push(`const __f = document.createDocumentFragment();`);
  emitExprInto(node, "__f", out);
  out.push(`return __f;`);
  return out;
}

function genBlock(node: any): string {
  return genFragment(node, []).join("\n");
}

/**
 * emitExprInto(node, parentVar, out)
 * 任意表达式 -> 渲染到 parentVar。这是整个编译器唯一的「发射入口」，
 * 嵌套的条件/map 都走这里递归，保证不会有 JSX 偷偷漏到输出里。
 */
function emitExprInto(node: any, parentVar: string, out: string[]): void {
  // arr.map(...)
  const m = detectMap(node);
  if (m) {
    const body: string[] = [];
    genFragment(m.body, body);
    const params = `${m.param}${m.index ? `, ${m.index}` : ""}`;
    // 顶层元素带 key 时，把 key 作为第 4 个参数交给 each —— 走 keyed 复用
    const keyArg = m.key ? `, (${params}) => (${m.key})` : "";
    out.push(
      `${EACH}(${parentVar}, () => (${m.array}), (${params}) => {\n${body.join(
        "\n"
      )}\n}${keyArg});`
    );
    return;
  }

  // cond ? a : b
  if (ts.isConditionalExpression(node)) {
    const cond = node.condition.getText();
    const thenOut: string[] = [];
    const elseOut: string[] = [];
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
    const thenOut: string[] = [];
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

function tagParts(node: any): any[] | null {
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

function emitNode(node: any, parentVar: string, out: string[]): void {
  if (!node) return;
  if (ts.isJsxFragment(node)) {
    node.children.forEach((c: any) => emitChild(c, parentVar, out));
    return;
  }
  const parts = tagParts(node);
  if (!parts) {
    const sf = node.getSourceFile();
    const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    throw new PlainCompileError({
      code: "PLAIN_E1004",
      file: sf.fileName,
      line: at.line + 1,
      column: at.character + 1,
      detail: `遇到不支持的语法节点 ${ts.SyntaxKind[node.kind]}（这是编译器 bug）`,
      hint: "请附最小复现提 issue",
    });
  }
  const [tagText, attrs, children] = parts;
  if (isComponentTag(tagText)) {
    emitComponent(tagText, attrs, children, parentVar, out);
    return;
  }
  emitElement(tagText, attrs, children, parentVar, out);
}

// --- props -----------------------------------------------------------------

function paramList(fn: any): string {
  return fn.parameters.map((p: any) => p.getText()).join(", ");
}

/** 把「返回 JSX 的箭头函数」编译成正常的函数：主要出现在组件 props 里 */
function genFnWithJsxBody(fn: any): string | null {
  let bodyNode: any = null;
  if (isJsxLike(unparen(fn.body))) bodyNode = unparen(fn.body);
  else if (ts.isBlock(fn.body)) {
    const ret = fn.body.statements.find(
      (s: any) => ts.isReturnStatement(s) && s.expression && isJsxLike(unparen(s.expression))
    );
    if (ret) bodyNode = unparen(ret.expression);
  }
  if (!bodyNode) return null;
  const out: string[] = [];
  emitNode(bodyNode, "__fb", out);
  return `(${paramList(fn)}) => {\nconst __fb = document.createDocumentFragment();\n${out.join(
    "\n"
  )}\nreturn __fb;\n}`;
}

function valueCode(exprNode: any): string {
  if (ts.isArrowFunction(exprNode) || ts.isFunctionExpression(exprNode)) {
    return genFnWithJsxBody(exprNode) || exprNode.getText();
  }
  return exprNode.getText();
}

function collectProps(attrs: any): string[] {
  const parts: string[] = [];
  attrs.properties.forEach((p: any) => {
    if (ts.isJsxAttribute(p)) {
      const raw = p.name.getText();
      // key 是列表复用的编译期指令（由 each 消费），不是组件的 prop
      if (raw === "key") return;
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

function emitComponent(
  tagText: string,
  attrs: any,
  children: any,
  parentVar: string,
  out: string[]
): void {
  const propsVar = fresh("props");
  const parts = collectProps(attrs);
  const meaningful = children.filter(
    (c: any) => !ts.isJsxText(c) || c.text.trim() !== ""
  );
  if (meaningful.length) {
    parts.push(`children: () => { ${genChildrenBody(meaningful)} }`);
  }
  out.push(`const ${propsVar} = { ${parts.join(", ")} };`);
  out.push(`${PLACE}(${parentVar}, ${tagText}(${propsVar}));`);
}

function genChildrenBody(children: any): string {
  const out: string[] = [];
  children.forEach((c: any) => emitChild(c, "__cf", out));
  return `const __cf = document.createDocumentFragment();\n${out.join(
    "\n"
  )}\nreturn __cf;`;
}

// --- 原生元素 --------------------------------------------------------------

const PROP_ALIAS: Record<string, string> = {
  for: "htmlFor",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  tabindex: "tabIndex",
  autofocus: "autofocus",
};

const DOM_PROPS = new Set<string>([
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

function emitElement(
  tagText: string,
  attrs: any,
  children: any,
  parentVar: string,
  out: string[]
): void {
  const el = fresh("el");
  out.push(`const ${el} = document.createElement(${JSON.stringify(tagText)});`);

  attrs.properties.forEach((p: any) => {
    if (ts.isJsxAttribute(p)) {
      const raw = p.name.getText();
      // key 由 each 消费，不能落到 DOM 属性上
      if (raw === "key") return;
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

  children.forEach((c: any) => emitChild(c, el, out));
  out.push(`${parentVar}.appendChild(${el});`);
}

// --- children --------------------------------------------------------------

function emitChild(child: any, parentVar: string, out: string[]): void {
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

function detectMap(node: any): any {
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
            const ret = cb.body.statements.find((s: any) => ts.isReturnStatement(s));
            return ret && ret.expression ? unparen(ret.expression) : null;
          })()
        : unparen(cb.body);
      if (body) {
        const keyAttr = detectKeyAttr(body);
        // keyed 复用下行只构建一次，回调捕获的 index 无法随位置更新。
        // 两者同时用必然导致其中一个语义静默失效 —— 所以编译期直接报错，
        // 而不是悄悄丢掉其中一个（静默降级违背「读代码就能推出行为」）。
        if (keyAttr && index && isIdentifierUsed(cb.body, index)) {
          const sf = keyAttr.node.getSourceFile();
          const at = sf.getLineAndCharacterOfPosition(keyAttr.node.getStart(sf));
          throw new PlainCompileError({
            code: "PLAIN_E1005",
            file: sf.fileName,
            line: at.line + 1,
            column: at.character + 1,
            detail:
              `列表元素的 key 与 index 参数不能同时使用` +
              `（key=${keyAttr.text}，index 参数 "${index}"）`,
            hint:
              `二者选一：想让节点跟着数据走，就删掉 index 参数、保留 key=${keyAttr.text}；` +
              `想用 index，就删掉 key`,
          });
        }
        return { array, param, index, body, key: keyAttr ? keyAttr.text : null };
      }
    }
  }
  return null;
}

/** 判断子树里是否真正引用了某个标识符（排除 obj.name / {name: 1} / key={name} 这类非变量引用） */
function isIdentifierUsed(root: any, name: string): boolean {
  let used = false;
  const visit = (n: any) => {
    if (used) return;
    if (
      ts.isIdentifier(n) &&
      n.text === name &&
      !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
      !(n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n) &&
      !(n.parent && ts.isJsxAttribute(n.parent) && n.parent.name === n)
    ) {
      used = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return used;
}

/**
 * 从 map 回调返回的 JSX 顶层元素上取出 key 表达式（key 只认顶层，与 React 一致）。
 * 同时把属性节点带出来，供 PLAIN_E1005 报位置。
 */
function detectKeyAttr(jsx: any): { text: string; node: any } | null {
  const parts = tagParts(jsx);
  if (!parts) return null;
  for (const p of parts[1].properties) {
    if (ts.isJsxAttribute(p) && p.name.getText() === "key" && p.initializer) {
      const init = p.initializer;
      if (ts.isStringLiteral(init) || ts.isNumericLiteral(init)) {
        return { text: JSON.stringify(init.text), node: p };
      }
      if (ts.isJsxExpression(init) && init.expression) {
        return { text: `(${init.expression.getText()})`, node: p };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 兜底校验：任何没被处理到的 JSX 都不能悄悄漏出去
// ---------------------------------------------------------------------------
function assertJsxCovered(sf: any, edits: any[], fileName: string): void {
  const missing: { line: number; column: number }[] = [];
  const visit = (node: any) => {
    if (isJsxLike(node) && !insideJsx(node)) {
      const start = node.getStart(sf);
      const end = node.getEnd();
      const covered = edits.some((e: any) => e.start <= start && end <= e.end);
      if (!covered) {
        const at = sf.getLineAndCharacterOfPosition(start);
        missing.push({ line: at.line + 1, column: at.character + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (missing.length) {
    const first = missing[0];
    throw new PlainCompileError({
      code: "PLAIN_E1001",
      file: fileName,
      line: first.line,
      column: first.column,
      detail:
        "这些位置的 JSX 编译器还不认识：" +
        missing.map((m) => `${fileName}:${m.line}`).join(", "),
      hint:
        "组件用 'return (<jsx/>)'；列表用 'arr.map(x => <jsx/>)'；" +
        "条件用 '{cond ? <a/> : <b/>}' 或 '{cond && <a/>}'",
    });
  }
}
