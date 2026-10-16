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
import type { PlainErrorCode } from "../errors.js";

export type { PlainErrorCode } from "../errors.js";

/** 编译器识别出的服务端函数：{ name, body } */
export interface ServerFunction {
  name: string;
  body: string;
}

/**
 * 编译器错误码 —— 机器可读，供 IDE / CI / AI 直接消费（SPEC §7「自解释错误」）。
 *
 * 全框架的错误码目录已收敛到 `src/errors.ts` 一处；这里保留一段面向编译器读者的说明，
 * 码本身从目录类型导入，避免两处各写各的。
 *
 * - `PLAIN_E1001` 有 JSX 落在编译器不认识的写法里
 * - `PLAIN_E1002` 生成的产物无法被 JS 解析（输入没先剥离 TS 类型）
 * - `PLAIN_E1003` 生成的产物里残留 JSX（编译器 bug）
 * - `PLAIN_E1004` 遇到不支持的语法节点（编译器 bug）
 * - `PLAIN_E1005` 列表元素的 key 与 index 参数同时使用（语义二选一）
 * - `PLAIN_E1006` `server()` 的函数体引用了外部变量（闭包不会跟到服务端）
 * - `PLAIN_E1007` `server()` 的调用参数 / 返回值无法 JSON 序列化（函数 / 类实例 / Stream）
 * - `PLAIN_E1008` JSX 属性展开 `{...expr}`（只做了半套支持，会静默跑错）
 * - `PLAIN_E2001` 契约检查未通过（由构建链路抛出，见 vite 插件）
 */

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

/**
 * `resource(...)` 调用点 key 的序号（**同一个文件里按源码顺序**，稳定可复现）。
 * 见 docs/rfcs/ssr-data.md §3.3：SSR 载荷要靠它把「服务端这次取到的值」与
 * 「客户端注水时的同一个调用点」配对。
 */
let resourceSeq = 0;

// helper 一律用别名引入，避免和用户自己的 import 重名
const E = "__effect";
const S = "__stringify";
const INS = "__insert";
const EACH = "__each";
const WHEN = "__when";
const RPC = "__rpc";

const PLACE = "__place";

/** 按命名空间创建元素（svg / math 自动 createElementNS），避免图标等不渲染 */
const CREATE_EL = "__createEl";

/** 命令式 DOM 逃逸口（ref={fn}）的运行时入口；内部符号，见 docs/rfcs/ref-escape-hatch.md */
const REF = "__ref";

const HELPER_IMPORT =
  `import { effect as ${E}, stringify as ${S}, insert as ${INS}, ` +
  `each as ${EACH}, when as ${WHEN}, rpc as ${RPC}, place as ${PLACE}, ` +
  `createEl as ${CREATE_EL}, ${REF} } from "plain";`;

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
  /**
   * `resource(...)` 调用点 key 的路径前缀（SSR 载荷配对用，见 docs/rfcs/ssr-data.md §3.3）。
   * 打包器应传**项目相对路径**：key 可读、不泄漏构建机绝对路径，且服务端与客户端
   * 两次构建对同一份源码得到同一个 key。不传则退回 `mapSource` / 文件名。
   */
  keyBase?: string;
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
  resourceSeq = 0;
  // 调用点 key 的前缀（见 docs/rfcs/ssr-data.md §3.3）：
  // 优先用打包器给的 keyBase（vite 插件传**项目相对路径** —— key 可读、不泄漏
  // 构建机绝对路径，且 SSR 构建与客户端构建对同一份源码得到**同一个 key**）。
  // 没给就退回 mapSource / 文件名。
  const keyPrefix = options.keyBase || options.mapSource || fileName;
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX
  );

  const edits: any[] = [];
  const serverFunctions: ServerFunction[] = [];
  // server() 的物理剥离要先知道「文件里存在哪些名字」——只有这些名字
  // 才可能在服务端变成 ReferenceError（见 assertServerSelfContained）
  const ambient = serverAmbientNames(sf);
  const serverNames = collectServerBoundNames(sf);
  const nonJsonNames = collectNonJsonBoundNames(sf);
  for (const n of serverNames) nonJsonNames.add(n);

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
        assertServerSelfContained(arg, ambient, fileName);
        // 返回值也要走 JSON：RPC 序列化时函数 / Stream 会悄悄变成 {} —— 静默失败
        assertServerReturnsSerializable(arg, nonJsonNames, fileName);
        serverFunctions.push({ name, body: arg.getText(sf) });
        edits.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          text: `((...__args) => ${RPC}(${JSON.stringify(name)}, __args))`,
        });
      }
    }

    // 1c) resource(fn) -> resource(fn, <owner 占位>, "调用点 key")
    //
    // 为什么由编译器给：SSR 首屏数据要随 HTML 迁移（见 docs/rfcs/ssr-data.md §3.3），
    // 而「服务端的这次取数」与「客户端注水时的同一个调用点」需要一个双方都认得的键。
    // 让 AI / 人手写这个键 = 又多一个会漏、会写错的东西；编译器给则是**必然存在**
    // 且两端一致（同一份源码 -> 同一个 key）。
    //
    // 只认裸标识符 `resource(...)`：别名导入（`import { resource as r }`）识别不到 ——
    // 那就没有键，退化成「注水后后台照常取一次」（结果正确，只多一次请求）。
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "resource" &&
      (node.arguments.length === 1 || node.arguments.length === 2)
    ) {
      const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const key = `${keyPrefix}:${at.line + 1}#${resourceSeq++}`;
      const last = node.arguments[node.arguments.length - 1];
      const text =
        node.arguments.length === 1
          ? `, undefined, ${JSON.stringify(key)}`
          : `, ${JSON.stringify(key)}`;
      edits.push({ start: last.getEnd(), end: last.getEnd(), text });
    }

    // 1b) 调用 server() 产物时传入无法 JSON 序列化的参数（PLAIN_E1007）
    //     只报 AST 上确知的函数 / 本文件的类实例 / 常见 Stream 类构造。
    //     标识符若看不出是什么，不猜 —— 误报会毁掉免疫系统的可信度。
    if (ts.isCallExpression(node)) {
      if (isServerCallSite(node, serverNames)) {
        assertServerArgsSerializable(node, nonJsonNames, fileName);
      }
    }

    // 2) 组件：箭头函数简洁体 => { 生成 fragment; return fragment; }
    //    同样不能只认「简洁体本身是 JSX」：`() => cond ? <a/> : <b/>` 的体是三元，
    //    但 emitMapItemBody / genFragment 会正确编译它。只认 JSX 会让它漏编译成
    //    PLAIN_E1003（JSX 残留）。与规则 3 口径一致：含 JSX 且函数会被 emit，就整体替换。
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      node.body &&
      !ts.isBlock(node.body) &&
      containsJsx(node.body) &&
      !insideJsx(node) &&
      !isCallArgument(node) &&
      (isMapCallback(node) || isTopLevelRenderFn(node))
    ) {
      edits.push({
        start: node.body.getStart(sf),
        end: node.body.getEnd(),
        text: `{\n${genBlock(unparen(node.body))}\n}`,
      });
    }

    // 3) 组件：渲染函数体里的 return（JSX / 条件 / && / .map / 普通值） => { ... return __f; }
    // 不能只认 `isJsxLike(expression)`：`return cond ? <a/> : <b/>` 的表达式不是 JSX，
    // 但 emitStmt 本来就会把它交给 genFragment（emitExprInto 按形状分派 when/each/insert）。
    // 只认 JSX 会让这类写法**漏编译**，JSX 残留到产物里，最后误报成 PLAIN_E1003「编译器 bug」。
    //
    // 位置范围也与 emitStmt 对齐：emitStmt 会递归 if / 块，所以 `if (x) return <p/>;`
    // 这种「提前 return」同样合法。判定交给 isEmittableReturnBody（只看最近的渲染函数），
    // 不再要求 return 必须直接挂在函数体上。
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      !insideJsx(node) &&
      isEmittableReturnBody(node)
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
  assertJsxCovered(sf, fileName);

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

// ---------------------------------------------------------------------------
// server() 自包含校验（PLAIN_E1006）
//
// 函数体会被物理搬进 .plain/server.mjs —— 那个文件里**只有函数体本身**：
// 没有 import，也没有模块作用域。所以任何「在本文件里声明过、却不在函数体内」的
// 引用，到了服务端都是 ReferenceError。这是纯静态可判定的。
//
// 刻意不去猜全局变量（process / Math / fetch …）：只报「我们确知文件里绑定了这个
// 名字、但它不在这段函数体里」的情况。猜全局必然误报，而误报会毁掉整个免疫系统的可信度。
// ---------------------------------------------------------------------------

/** 收集一棵子树里所有「声明」出来的名字（变量 / 参数 / 函数 / 类 / catch / import 绑定） */
function collectDeclaredNames(root: any, out: Set<string>): Set<string> {
  const bind = (name: any) => {
    if (!name) return;
    if (ts.isIdentifier(name)) out.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      name.elements.forEach((el: any) => {
        if (ts.isBindingElement(el)) bind(el.name);
      });
    }
  };
  const visit = (n: any) => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) bind(n.name);
    else if (ts.isCatchClause(n) && n.variableDeclaration) bind(n.variableDeclaration.name);
    else if (
      (ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isFunctionExpression(n)) &&
      n.name
    ) {
      out.add(n.name.text);
    } else if (ts.isImportClause(n) && n.name) out.add(n.name.text);
    else if (ts.isImportSpecifier(n) || ts.isNamespaceImport(n)) out.add(n.name.text);
    else if (ts.isImportEqualsDeclaration(n)) out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** 这个标识符是「引用」还是仅仅是个名字（属性名 / 键名 / JSX 属性名 / import 别名） */
function isNamePosition(n: any): boolean {
  const p = n.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return true;
  if (ts.isPropertyAssignment(p) && p.name === n) return true;
  if (ts.isJsxAttribute(p) && p.name === n) return true;
  if (ts.isImportSpecifier(p)) return true;
  if (ts.isBindingElement(p) && p.propertyName === n) return true;
  if (ts.isQualifiedName(p) && p.right === n) return true;
  return false;
}

/**
 * 算出「会被搬走的那些函数体之外、文件里绑定了的名字」集合。
 * 注意要排除：
 *   - 其它 server() 函数名 —— 它们都会出现在同一份清单里，互相引用是合法的
 *   - 各 server() 函数体内的局部声明 —— 否则 A 的局部变量会误伤 B
 */
function serverAmbientNames(sf: any): Set<string> {
  const serverFns: any[] = [];
  const scan = (n: any) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "server" &&
      n.arguments.length &&
      (ts.isArrowFunction(n.arguments[0]) || ts.isFunctionExpression(n.arguments[0]))
    ) {
      serverFns.push(n.arguments[0]);
    }
    ts.forEachChild(n, scan);
  };
  scan(sf);

  const serverBound = new Set<string>();
  for (const fn of serverFns) {
    let cur = fn.parent;
    while (cur) {
      if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
        serverBound.add(cur.name.text);
        break;
      }
      cur = cur.parent;
    }
  }

  const inBodies = new Set<string>();
  for (const fn of serverFns) collectDeclaredNames(fn, inBodies);

  const ambient = collectDeclaredNames(sf, new Set<string>());
  for (const name of inBodies) ambient.delete(name);
  for (const name of serverBound) ambient.delete(name);
  return ambient;
}

/** 报出 server() 里引用外部变量的地方 */
function assertServerSelfContained(
  fn: any,
  ambient: Set<string>,
  fileName: string
): void {
  const local = collectDeclaredNames(fn, new Set<string>());
  const leaks: string[] = [];
  const visit = (n: any) => {
    if (
      ts.isIdentifier(n) &&
      !isNamePosition(n) &&
      !local.has(n.text) &&
      ambient.has(n.text) &&
      !leaks.includes(n.text)
    ) {
      leaks.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  if (!leaks.length) return;

  const sf = fn.getSourceFile();
  const at = sf.getLineAndCharacterOfPosition(fn.getStart(sf));
  throw new PlainCompileError({
    code: "PLAIN_E1006",
    file: fileName,
    line: at.line + 1,
    column: at.character + 1,
    detail: `server() 的函数体引用了外部变量：${leaks.join(", ")}`,
    hint:
      "函数体会被物理搬到服务端，闭包不会跟过去。" +
      "请在函数体内自己获取（如 process.env.DB_URL、await import(\"./db.js\")），" +
      "或把值作为参数传进来",
  });
}

/** 本文件里绑定到 server() 的变量名 */
function collectServerBoundNames(sf: any): Set<string> {
  const names = new Set<string>();
  const scan = (n: any) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "server"
    ) {
      let cur = n.parent;
      while (cur) {
        if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
          names.add(cur.name.text);
          break;
        }
        cur = cur.parent;
      }
    }
    ts.forEachChild(n, scan);
  };
  scan(sf);
  return names;
}

/**
 * 本文件里确知「传给 RPC 一定坏掉」的名字：函数 / 类 / 绑定到函数表达式的 const。
 * 不去把普通变量算进来。
 */
function collectNonJsonBoundNames(sf: any): Set<string> {
  const names = new Set<string>();
  const bind = (name: any) => {
    if (ts.isIdentifier(name)) names.add(name.text);
  };
  const visit = (n: any) => {
    if (ts.isFunctionDeclaration(n) && n.name) names.add(n.name.text);
    if (ts.isClassDeclaration(n) && n.name) names.add(n.name.text);
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer;
      if (
        ts.isArrowFunction(init) ||
        ts.isFunctionExpression(init) ||
        ts.isClassExpression(init)
      ) {
        bind(n.name);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

function isServerFactoryCall(n: any): boolean {
  return (
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "server"
  );
}

/** 是「调用已经剥离的 server 函数」，不是 `server(fn)` 工厂本身 */
function isServerCallSite(node: any, serverNames: Set<string>): boolean {
  if (!ts.isCallExpression(node) || isServerFactoryCall(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee) && serverNames.has(callee.text)) return true;
  // server(fn)(args) 立即调用
  if (isServerFactoryCall(callee)) return true;
  return false;
}

const NON_JSON_CTORS = new Set([
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "FormData",
  "Blob",
  "File",
  "Request",
  "Response",
  "Headers",
]);

function ctorName(n: any): string | null {
  const c = n.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.name)) return c.name.text;
  return null;
}

/** 返回无法序列化的原因；能序列化或看不出来则返回 null（不猜） */
function nonJsonReason(expr: any, nonJsonNames: Set<string>): string | null {
  if (!expr) return null;
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }

  if (
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e) ||
    ts.isFunctionDeclaration(e)
  ) {
    return "函数";
  }
  if (ts.isClassExpression(e) || ts.isClassDeclaration(e)) {
    return "类";
  }
  if (ts.isNewExpression(e)) {
    const name = ctorName(e);
    if (name && NON_JSON_CTORS.has(name)) return `Stream/二进制实例 "${name}"`;
    if (name && nonJsonNames.has(name)) return `类实例 "${name}"`;
    return null;
  }
  if (ts.isIdentifier(e) && nonJsonNames.has(e.text)) {
    return `函数/类 "${e.text}"`;
  }
  if (ts.isObjectLiteralExpression(e)) {
    for (const p of e.properties) {
      if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
        return "带方法的对象";
      }
      if (ts.isPropertyAssignment(p)) {
        const why = nonJsonReason(p.initializer, nonJsonNames);
        if (why) return why;
      }
      if (ts.isShorthandPropertyAssignment(p) && nonJsonNames.has(p.name.text)) {
        return `函数/类 "${p.name.text}"`;
      }
      if (ts.isSpreadAssignment(p)) {
        const why = nonJsonReason(p.expression, nonJsonNames);
        if (why) return why;
      }
    }
    return null;
  }
  if (ts.isArrayLiteralExpression(e)) {
    for (const el of e.elements) {
      if (ts.isSpreadElement(el)) {
        const why = nonJsonReason(el.expression, nonJsonNames);
        if (why) return why;
      } else {
        const why = nonJsonReason(el, nonJsonNames);
        if (why) return why;
      }
    }
  }
  return null;
}

function assertServerArgsSerializable(
  call: any,
  nonJsonNames: Set<string>,
  fileName: string
): void {
  for (const arg of call.arguments) {
    if (ts.isSpreadElement(arg)) continue;
    const why = nonJsonReason(arg, nonJsonNames);
    if (!why) continue;
    throwSerializationError(
      arg,
      `server() 的调用参数无法 JSON 序列化（${why}）`,
      fileName
    );
  }
}

/**
 * server() 的返回值同样走 JSON —— 返回函数 / 类实例 / Stream 会被 RPC 的
 * JSON.stringify 悄悄丢成 {} 或 undefined，客户端不报错、只是拿到空值。
 * 只扫「不属于嵌套函数」的 return：嵌套函数自己的返回值不过 RPC 边界，不猜。
 * 注：引用外层名字的 return 会先被 PLAIN_E1006 拦下，这里管的是函数体内自产的坏值。
 */
function assertServerReturnsSerializable(
  fn: any,
  nonJsonNames: Set<string>,
  fileName: string
): void {
  const body = fn.body;
  if (!body) return;
  // 简洁体 () => expr 等价于 return expr
  if (!ts.isBlock(body)) {
    const why = nonJsonReason(body, nonJsonNames);
    if (why) {
      throwSerializationError(
        body,
        `server() 的返回值无法 JSON 序列化（${why}）`,
        fileName
      );
    }
    return;
  }
  const scan = (n: any) => {
    if (ts.isFunctionLike(n)) return; // 嵌套函数内部的 return 不过 RPC 边界
    if (ts.isReturnStatement(n) && n.expression) {
      const why = nonJsonReason(n.expression, nonJsonNames);
      if (why) {
        throwSerializationError(
          n,
          `server() 的返回值无法 JSON 序列化（${why}）`,
          fileName
        );
      }
    }
    ts.forEachChild(n, scan);
  };
  scan(body);
}

/** 抛出 PLAIN_E1007（调用参数与返回值共用同一错误码） */
function throwSerializationError(
  node: any,
  detail: string,
  fileName: string
): never {
  const sf = node.getSourceFile();
  const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  throw new PlainCompileError({
    code: "PLAIN_E1007",
    file: fileName,
    line: at.line + 1,
    column: at.character + 1,
    detail,
    hint:
      "参数与返回值都走 JSON：不要传 / 返回函数、类实例、Stream。" +
      "把逻辑写进 server() 函数体，只让可序列化的数据过边界",
  });
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
  const f = fresh("f");
  out.push(`const ${f} = document.createDocumentFragment();`);
  emitExprInto(node, f, out);
  out.push(`return ${f};`);
  return out;
}

/**
 * 该 return 的表达式是否应当整体编译成「建 fragment 并返回」。
 *
 * 判据与 `emitStmt` 对齐（emitStmt 对组件体/渲染函数体内的 return 一律走 genFragment），
 * 条件：
 *   1. 表达式里**确实含、且由本表达式自己 emit** 的 JSX（见 containsJsx —— 函数边界为准，
 *      所以 `return () => <jsx/>` 这种「返回一个组件」不算，归内层箭头自己编译）；
 *   2. 该 return 直接位于「会被 emit 的函数体」—— 即最近的函数是渲染函数
 *      （组件顶层 / 函数声明 / 工厂 return 的箭头）或 `.map(cb)` 回调（与 assertJsxCovered
 *      的口径一致），排除 IIFE 等不会走 emitStmt 的匿名调用。
 */
function isEmittableReturnBody(ret: any): boolean {
  if (!containsJsx(ret.expression)) return false;
  const fn = nearestFunction(ret);
  if (!fn) return false;
  return isMapCallback(fn) || isTopLevelRenderFn(fn);
}

/**
 * 该表达式里是否含「**会被本表达式自己 emit** 的 JSX」——
 * 即 JSX 直接暴露在 genFragment 的形状分派里（JSX / 三元 / `&&` / `.map`），
 * 而不是藏在一个独立的嵌套渲染函数里（那种由该函数自己的编译规则处理）。
 *
 * ★ 边界就是「函数边界」：
 *   - `xs.map(x => <li/>)` 的 JSX **属于本表达式**（emitMapItemBody 会编译它）→ 穿透回调；
 *   - `() => <JSX/>`（工厂返回值）的 JSX 属于**那个箭头函数自己**（由规则 2 处理）→ 不穿透。
 *   所以：遇到函数就停，`.map(cb)` 的回调例外；**顶层 node 本身是函数时也停**
 *   （`return () => <JSX/>` 问的是「这个箭头值是不是含 JSX 的表达式」—— 不是，它是个函数）。
 */
function containsJsx(node: any): boolean {
  if (!node) return false;
  if (isJsxLike(node)) return true;
  // 顶层就是函数字面量：它是「值」，里面的 JSX 归它自己编译，不算本表达式持有
  if (ts.isFunctionLike(node)) return false;
  let found = false;
  const visit = (n: any) => {
    if (found) return;
    // 遇到嵌套函数就停 —— 但 `.map(cb)` 的回调例外：它的 JSX 由 emitMapItemBody
    // 负责编译（是「本表达式的一部分」），不是独立的渲染函数。
    if (ts.isFunctionLike(n) && !isMapCallback(n)) return;
    if (isJsxLike(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function genBlock(node: any): string {
  return genFragment(node, []).join("\n");
}

/** 把 map 回调体逐语句转成 item 模板：return <jsx> 编译成 fragment 返回，其余原样保留 */
function emitMapItemBody(cbBody: any, out: string[]): void {
  if (ts.isBlock(cbBody)) {
    for (const stmt of cbBody.statements) emitStmt(stmt, out);
  } else {
    genFragment(unparen(cbBody), out);
  }
}

/**
 * 递归发射一条语句：
 *  - return <jsx>  -> 编译成 fragment 并返回（支持多 return / if 内提前 return）
 *  - 其它语句原样保留；if / 块 会递归处理其中嵌套的 return <jsx>
 */
function emitStmt(stmt: any, out: string[]): void {
  if (ts.isReturnStatement(stmt)) {
    if (stmt.expression) {
      // 任何 return 表达式（JSX / 条件 / && / .map / 普通值）都交给 genFragment
      // 统一编译成 fragment 返回，避免漏编译条件 / 布尔表达式里的 JSX。
      genFragment(unparen(stmt.expression), out);
    } else {
      out.push(`return;`);
    }
    return;
  }
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) emitStmt(s, out);
    return;
  }
  if (ts.isIfStatement(stmt)) {
    out.push(`if (${stmt.expression.getText()}) {`);
    emitStmt(stmt.thenStatement, out);
    out.push(`}`);
    if (stmt.elseStatement) {
      out.push(`else {`);
      emitStmt(stmt.elseStatement, out);
      out.push(`}`);
    }
    return;
  }
  out.push(stmt.getText());
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
    const bodyArr: string[] = [];
    // 把 map 回调体逐语句转成 item 模板（修复：之前会整体丢弃 return 之前的
    // const / effect，或漏编译「提前 return」里的 JSX）。支持多 return / if 包裹的 return。
    emitMapItemBody(m.cbBody, bodyArr);
    const params = `${m.param}${m.index ? `, ${m.index}` : ""}`;
    // 顶层元素带 key 时，把 key 作为第 4 个参数交给 each —— 走 keyed 复用
    const keyArg = m.key ? `, (${params}) => (${m.key})` : "";
    out.push(
      `${EACH}(${parentVar}, () => (${m.array}), (${params}) => {\n${bodyArr.join(
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

/**
 * 拒绝 JSX 属性展开 `{...expr}`（PLAIN_E1008）。
 *
 * 展开只被编译器「半实现」：它不会像显式属性那样包进 `effect`（信号变了不更新），
 * 也没有走 class / style / value 的正确属性路径 —— 会**静默跑错**。
 * 与其留一个半对的行为，不如在编译期直接报错：这正是本框架「消灭静默语义降级」的取舍
 * （与 `PLAIN_E1005` 拒绝 key + index 同一条理由）。
 */
function assertNoSpreadAttrs(attrs: any, sf: any): void {
  const spread = attrs.properties.find((p: any) => ts.isJsxSpreadAttribute(p));
  if (!spread) return;
  const at = sf.getLineAndCharacterOfPosition(spread.getStart(sf));
  throw new PlainCompileError({
    code: "PLAIN_E1008",
    file: sf.fileName,
    line: at.line + 1,
    column: at.character + 1,
    detail:
      "JSX 属性展开 {...} 不支持：展开只在创建时求值一次，不会进入响应式更新，" +
      "也绕过了 class / style / value 的正确处理 —— 会静默跑错。",
    hint:
      "改成显式属性，例如 <Card title={t()} onSave={save} />；" +
      "确实要透传一组属性时，请逐个列出。",
  });
}

/** 是否为 async 函数（箭头 / 函数表达式） */
function isAsyncFunction(fn: any): boolean {
  return !!(
    fn.modifiers &&
    fn.modifiers.some((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

/** 抛出 ref 相关的编译错误（PLAIN_E1009 / E1010 / E1011） */
function throwRefError(
  code: PlainErrorCode,
  node: any,
  detail: string,
  hint: string
): never {
  const sf = node.getSourceFile();
  const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  throw new PlainCompileError({
    code,
    file: sf.fileName,
    line: at.line + 1,
    column: at.character + 1,
    detail,
    hint,
  });
}

/**
 * 编译内建元素上的 `ref={fn}` -> `__ref(el, fn)`（命令式 DOM 逃逸口）。
 *
 * 语义：元素**连入文档后**调用一次 fn(el)，返回的清理函数随 owner 回收
 * （≈ 平台的 connectedCallback / disconnectedCallback）。只接受函数形态；
 * 明显的非函数、async、返回 JSX 一律编译期报错，不做静默降级。
 * 设计见 docs/rfcs/ref-escape-hatch.md。
 */
function emitRefAttr(el: string, attr: any, out: string[]): void {
  const init = attr.initializer;
  const hint =
    "写成 ref={(el) => { … }}；元素连入文档后会用它调用一次，可返回清理函数";
  if (!init || ts.isStringLiteral(init) || ts.isNumericLiteral(init)) {
    throwRefError("PLAIN_E1010", attr, "ref 需要一个函数：ref={(el) => …}", hint);
  }
  if (!ts.isJsxExpression(init) || !init.expression) {
    throwRefError("PLAIN_E1010", attr, "ref 需要一个函数：ref={(el) => …}", hint);
  }
  const expr = unparen(init.expression);
  // 明确的非函数字面量：直接报错。标识符 / 调用 / 成员表达式看不出类型，交给运行期兜底。
  if (
    ts.isStringLiteral(expr) ||
    ts.isNumericLiteral(expr) ||
    ts.isObjectLiteralExpression(expr) ||
    ts.isArrayLiteralExpression(expr) ||
    ts.isTemplateExpression(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    throwRefError("PLAIN_E1010", attr, "ref 的值必须是函数", hint);
  }
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    if (isAsyncFunction(expr)) {
      throwRefError(
        "PLAIN_E1011",
        expr,
        "ref 回调不能是 async",
        "清理与异步不兼容：把 await 提到回调外，或在回调里自己 catch"
      );
    }
    if (isJsxLike(unparen(expr.body))) {
      throwRefError(
        "PLAIN_E1010",
        expr,
        "ref 回调不能返回 JSX（它返回的应是清理函数）",
        "JSX 请放到组件里；ref 回调只做命令式操作，可返回一个清理函数"
      );
    }
  }
  out.push(`${REF}(${el}, ${expr.getText()});`);
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
  assertNoSpreadAttrs(attrs, node.getSourceFile());
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
    }
    // 展开属性 {...expr} 由 assertNoSpreadAttrs 在编译期直接拒绝（PLAIN_E1008）
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
  // ref 只能放在内建元素上：组件不保证有根节点，静默忽略会变成"静默失败"
  const refAttr = attrs.properties.find(
    (p: any) => ts.isJsxAttribute(p) && p.name.getText() === "ref"
  );
  if (refAttr) {
    throwRefError(
      "PLAIN_E1009",
      refAttr,
      `组件 <${tagText}> 上不支持 ref`,
      "ref 只能放在内建元素上：把 ref 放到组件内部的元素上，或改用 props 把节点回调传进组件"
    );
  }
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
  // 用 createEl 而非裸 document.createElement：svg / math 及其后代需正确命名空间，
  // 否则 <polyline> 等被当成未知 HTML 标签而不渲染（详见 runtime/dom.ts createEl）。
  out.push(`const ${el} = ${CREATE_EL}(${JSON.stringify(tagText)}, ${parentVar});`);

  attrs.properties.forEach((p: any) => {
    if (ts.isJsxAttribute(p)) {
      const raw = p.name.getText();
      // key 由 each 消费，不能落到 DOM 属性上
      if (raw === "key") return;
      // ref 是命令式逃逸口的编译期指令（见 docs/rfcs/ref-escape-hatch.md）
      if (raw === "ref") {
        emitRefAttr(el, p, out);
        return;
      }
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
    }
    // 展开属性 {...expr} 由 assertNoSpreadAttrs 在编译期直接拒绝（PLAIN_E1008）
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
      const cbBody = cb.body;
      const body = ts.isBlock(cbBody)
        ? (() => {
            const stmts = cbBody.statements;
            const ret = stmts.find((s: any) => ts.isReturnStatement(s));
            return ret && ret.expression ? unparen(ret.expression) : null;
          })()
        : unparen(cbBody);
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
        return { array, param, index, body, cbBody, key: keyAttr ? keyAttr.text : null };
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
/**
 * 兜底校验：任何 JSX 都必须落在「编译器会 emit 它的位置」。
 *
 * 编译器的 JSX 处理入口只有两处，判定也按这两处反推：
 *   A. `emitChild` → `emitExprInto`：处理 `<div>{expr}</div>` 里的子表达式，
 *      且只认 4 种形状（map / 三元 / && / 直接 JSX 或普通表达式）。
 *   B. `emitMapItemBody`：处理 `arr.map(cb)` 回调体内的 `return <jsx/>`。
 *
 * 于是「被 emit」的充要条件是：沿父链向上，在**不跨过函数边界**的前提下，
 * 遇到的第一个「持有者」必须是下列之一：
 *   - JsxElement / JsxFragment（直接子节点）
 *   - JsxExpression（`{expr}`，且 JSX 就是该表达式本身）
 *   - ConditionalExpression 的 whenTrue/whenFalse
 *   - `&&` BinaryExpression 的 right
 *   - ReturnStatement —— 但要求该 return 所在的最近函数是 map 回调，
 *     或者是渲染函数（组件顶层 / 函数声明 / 工厂 return 的箭头）
 *
 * 注意：JSX 可以先藏在**一层控制流表达式**里再被 emit —— `return cond ? <a/> : <b/>`
 * 的 JSX 父节点是 ConditionalExpression，emit 它的是外层 return（emitStmt 把任何
 * return 表达式都交给 genFragment）。所以判定前要**向上穿透**括号 / as / 三元 / `&&`。
 * 唯独 `||` / `??` 不穿透：它们不在支持的控制流形状里，会落到 insert 兜底，JSX 不会被
 * emit —— 必须报错，而不是放过去等到 assertClean 报成「编译器 bug」。
 *
 * 其余情况（`||` / `??` 右侧、数组字面量、IIFE、链式 `.filter()` 尾部的箭头体）一律报错。
 */
function assertJsxCovered(sf: any, fileName: string): void {
  const missing: { line: number; column: number }[] = [];
  const visit = (node: any) => {
    if (isJsxLike(node) && !isEmittedJsx(node)) {
      const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      missing.push({ line: at.line + 1, column: at.character + 1 });
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
        "组件渲染函数的 'return' 里可以写任意含 JSX 的表达式：" +
        "'return (<jsx/>)'、'return cond ? <a/> : <b/>'、'return cond && <a/>'、" +
        "'return xs.map(x => <li/>)'；列表用 'arr.map(x => <jsx/>)'；" +
        "条件用 '{cond ? <a/> : <b/>}' 或 '{cond && <a/>}'。" +
        "不支持的形状（'||' / '??' 短路的 JSX、数组字面量、IIFE、链式后置 .filter()）" +
        "请先赋值给变量再插值：const node = cond || <a/>; 然后 {node}；" +
        "或把该分支抽成一个返回 JSX 的组件函数。",
    });
  }
}

/**
 * 该 JSX 是否处于编译器会 emit 它的位置（见 assertJsxCovered 注释）
 *
 * 关键：JSX 可以**藏在一层控制流表达式里**再被 emit。
 * 例如 `return cond ? <a/> : <b/>` —— JSX 的父节点是 ConditionalExpression，
 * 而真正 emit 它的是外层那条 return（emitStmt 把**任何** return 表达式交给
 * genFragment，再由 emitExprInto 按形状分派）。所以要**向上穿透**这些
 * 「会原样透传给 emitExprInto 的表达式」，落到真正的 holder 再判定。
 *
 * 穿透的边界：只允许「结构性」节点（括号 / as / 三元 / && / || / ?? / 逗号），
 * 一旦遇到 CallExpression / ArrayLiteral / 函数字面量等就停 —— 那些是
 * 编译器**不会**自动展开的位置（要用户先赋值给变量）。
 */
function isEmittedJsx(node: any): boolean {
  // 第一步：从 node 出发，向上穿过「括号 / as / 控制流」直到真正的 holder
  let expr = node;
  for (;;) {
    const p = expr.parent;
    if (!p) return false;

    // 括号 / as：语义透明，继续上穿
    if (ts.isParenthesizedExpression(p) || (ts.isAsExpression(p) && p.expression === expr)) {
      expr = p;
      continue;
    }
    // 三元分支：当分支本身就是 JSX（或包裹它的表达式）时，继续上穿到三元整体
    if (ts.isConditionalExpression(p) && (p.whenTrue === expr || p.whenFalse === expr)) {
      expr = p;
      continue;
    }
    // `&&` 的右侧可以上穿（emitExprInto 会编译成 when）。
    // `||` / `??` **不能**：它们不在编译器支持的控制流形状里，会落到 insert 兜底，
    // 而 insert 直接内联表达式源码 —— 里面的 JSX 不会被 emit，最后残留成 PLAIN_E1003。
    // 因此这里不穿透，让这些 JSX 落回「不支持」判定，报出正确的 PLAIN_E1001。
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (k === ts.SyntaxKind.AmpersandAmpersandToken && p.right === expr) {
        expr = p;
        continue;
      }
    }
    break; // 遇到不透明节点，expr 就是 holder（或它所在的直接表达式）
  }

  const holder = expr.parent;
  if (!holder) return false;

  // 直接子节点：<div><p/></div>
  if (ts.isJsxElement(holder) || ts.isJsxFragment(holder)) return true;

  // {expr} 子表达式：穿透后 expr 必须正好是 holder 的表达式
  if (ts.isJsxExpression(holder)) return holder.expression === expr;

  // 箭头函数隐式返回体：() => <jsx/>
  // 合法来源：① .map(cb) 回调（emitMapItemBody）；② JSX 属性值（渲染函数 prop）。
  if (ts.isArrowFunction(holder) && holder.body === expr) {
    return isMapCallback(holder) || isTopLevelRenderFn(holder);
  }

  // return <expr>：要求该 return 位于「会被 emit 的渲染函数」，
  // 且该函数是 map 回调或组件顶层。注意 expr 可能是 JSX 本身，也可能是
  // 穿透上来的三元 / && —— 两者都由 emitStmt -> genFragment 统一处理。
  // emitStmt 会递归 if / 块，所以提前 return（`if (x) return <p/>;`）同样合法，
  // 这里不再要求 return 必须直接挂在函数体上。
  if (ts.isReturnStatement(holder)) {
    const fn = nearestFunction(holder);
    if (!fn) return false;
    if (isMapCallback(fn)) return true;
    return isTopLevelRenderFn(fn);
  }

  return false;
}

/**
 * 该函数是否是「组件顶层渲染函数」——即它的 return / 隐式体会被 emitNode / emitComponent 消费。
 * 判据：函数有名字（声明 / 命名函数表达式），或作为组件被导出 / 赋值 / 作为 JSX 属性值 /
 * 作为工厂函数的返回值（`return () => <jsx/>`、`return function App() {...}`）。
 * **排除**被立即调用的函数（IIFE）——`(() => { return <p/>; })()` 不会被 emit。
 */
function isTopLevelRenderFn(fn: any): boolean {
  if (ts.isFunctionDeclaration(fn) && fn.name) return true;
  const p = fn.parent;
  if (!p) return false;
  // 被立即调用：(() => …)() —— 父或（括号后的）祖父是 CallExpression
  if (ts.isCallExpression(p)) return false;
  if (ts.isParenthesizedExpression(p) && p.parent && ts.isCallExpression(p.parent)) {
    return false;
  }
  // const C = () => <jsx/>;  export default () => <jsx/>;
  if (ts.isVariableDeclaration(p) || ts.isExportAssignment(p)) return true;
  // { fallback: () => <jsx/> } —— 对象属性
  if (ts.isPropertyAssignment(p)) return true;
  // fallback={(...) => <jsx/>} —— JSX 属性值（组件 props 里的渲染函数，
  // 由 valueCode -> genFnWithJsxBody 处理）
  if (ts.isJsxExpression(p) && p.expression === fn) {
    const attr = p.parent;
    if (attr && ts.isJsxAttribute(attr)) return true;
  }
  // return () => <jsx/>;  /  return function App() {...} —— 组件工厂的返回值，
  // 由 emitStmt 的 genFragment 处理
  if (ts.isReturnStatement(p) && p.expression === fn) return true;
  return false;
}

/** 向上找最近的函数节点（箭头 / 函数声明 / 函数表达式） */
function nearestFunction(node: any): any {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isArrowFunction(cur) ||
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * 该函数节点是否是某个 `.map(cb)` 的回调，**且该 `.map()` 会被编译器识别**。
 * 后者要求整个调用不是更长链式表达式的一部分
 * （`items().map(cb).filter(Boolean)` 里的 cb 不会被 emitMapItemBody 处理）。
 */
function isMapCallback(fn: any): boolean {
  const p = fn.parent;
  if (!p || !ts.isCallExpression(p)) return false;
  if (p.arguments.indexOf(fn) !== 0) return false;
  const callee = p.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "map") {
    return false;
  }
  // 该 .map(...) 调用不能是更长的属性/调用链的一环
  const outer = p.parent;
  if (outer && ts.isPropertyAccessExpression(outer) && outer.expression === p) {
    return false;
  }
  return true;
}
