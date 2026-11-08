#!/usr/bin/env node
/**
 * 0.3 → 0.4 自动迁移脚本（TypeScript AST codemod）。
 *
 * 只做「机械且可判定」的改写，语义判断仍留给第 2 步人工审计：
 * - 删除从 `plain` 导入的 `resolve`，调用点改成直接读 `props.x`；
 * - `resolve(props.children)` 改成 `props.children?.()`（children 仍是 lazy thunk）；
 * - `MaybeGetter<T>` → `T`（children 特例为 `() => T`）；
 * - `Renderable | (() => Renderable)` → `Renderable`（children 特例为 `() => Renderable`）；
 * - 原生元素上的零参箭头属性 → 直接表达式；
 * - 组件上的零参箭头属性：只改 `--value-props` 名单内的名字，其余列为「需人工确认」；
 * - 清掉已失效的 `PLAIN_E1108` / `plain-ignore-* PLAIN_E1112` 抑制指令；
 * - 可选：代码示例字符串里的旧写法（`--code-samples`）。
 *
 * 设计约束见 `AGENTS.md` §7.9：迁移工具不是兼容层，只把代码收敛到 0.4 的唯一写法。
 *
 * @example
 *   node scripts/migrate-0.3-to-0.4.mjs --dry-run src
 *   node scripts/migrate-0.3-to-0.4.mjs --value-props open,value,current src
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.plain', 'coverage', 'build']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const PLAIN_MODULES = new Set(['plain']);

/**
 * 常见「值 prop」名单：0.3 里这些 prop 可能被写成 `x={() => expr}`。
 * 原生元素属性不受名单限制（一律改写）；组件属性只在名单内改写。
 */
const DEFAULT_VALUE_PROPS = [
  'open', 'value', 'current', 'page', 'expandedKeys', 'checkedKeys', 'data',
  'sortKey', 'sortDir', 'selectedKeys', 'activeKeys', 'target', 'to',
  'min', 'max', 'step', 'height', 'width', 'label', 'options', 'items',
  'defaultValue', 'defaultOpen', 'defaultPage', 'defaultCheckedKeys',
  'defaultExpandedKeys', 'glass', 'class', 'className', 'style', 'id', 'title',
  'disabled', 'variant', 'size', 'fields', 'columns', 'percentile', 'median',
];

/** 代码示例字符串里可能出现的原生属性名（字符串里没有标签上下文，只能按名单）。 */
const SAMPLE_NATIVE_PROPS = [
  'value', 'title', 'class', 'className', 'style', 'id', 'disabled', 'checked',
  'selected', 'placeholder', 'href', 'src', 'alt', 'type', 'name', 'min', 'max',
  'step', 'width', 'height',
];

/** AST 里可安全直接内联的简单表达式；其余加括号避免优先级变化。 */
const SIMPLE_KINDS = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.ElementAccessExpression,
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.TypeAssertionExpression,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.ThisKeyword,
]);

/** 打印命令行用法。 */
function printUsage() {
  console.log(`用法：
  node scripts/migrate-0.3-to-0.4.mjs [选项] <目录或文件...>

选项：
  --dry-run            只预览，不写盘
  --value-props <a,b>  在内置值 prop 名单之外追加名字（组件上的零参箭头会被展开）
  --code-samples       同时改写字符串 / 模板字符串里的代码示例
  --quiet              只打印汇总
  -h, --help           显示本帮助`);
}

/**
 * 解析命令行参数。
 * @param {string[]} argv
 * @returns {{targets: string[], dryRun: boolean, valueProps: Set<string>,
 *   codeSamples: boolean, quiet: boolean}}
 */
function parseArgs(argv) {
  const targets = [];
  const valueProps = new Set(DEFAULT_VALUE_PROPS);
  let dryRun = false;
  let codeSamples = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--code-samples') {
      codeSamples = true;
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--value-props') {
      const list = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const name of list) valueProps.add(name);
    } else if (arg.startsWith('--value-props=')) {
      const list = arg.slice('--value-props='.length).split(',').map((s) => s.trim());
      for (const name of list.filter(Boolean)) valueProps.add(name);
    } else if (arg.startsWith('-')) {
      throw new Error(`未知选项：${arg}`);
    } else {
      targets.push(arg);
    }
  }
  return { targets, dryRun, valueProps, codeSamples, quiet };
}

/**
 * 递归收集目标目录下的源码文件。
 * @param {string} target 文件或目录
 * @returns {string[]} 绝对路径列表
 */
function collectFiles(target) {
  const abs = path.resolve(target);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat) throw new Error(`路径不存在：${target}`);
  if (stat.isFile()) return SOURCE_EXTS.has(path.extname(abs)) ? [abs] : [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(path.join(abs, entry.name)));
    } else if (SOURCE_EXTS.has(path.extname(entry.name))) {
      out.push(path.join(abs, entry.name));
    }
  }
  return out;
}

/**
 * 按扩展名选择 TypeScript 解析模式。
 * @param {string} file
 * @returns {ts.ScriptKind}
 */
function scriptKindFor(file) {
  switch (path.extname(file)) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

/**
 * 读取 import 声明的模块名（去掉引号）。
 * @param {ts.ImportDeclaration} node
 * @param {ts.SourceFile} sf
 * @returns {string}
 */
function moduleNameOf(node, sf) {
  return node.moduleSpecifier.getText(sf).replace(/^['"]|['"]$/g, '');
}

/**
 * 判断表达式是否形如 `props` / `this.props` / `x.props`。
 * @param {ts.Expression} expr
 * @returns {boolean}
 */
function isPropsLike(expr) {
  if (ts.isIdentifier(expr)) return expr.text === 'props';
  return ts.isPropertyAccessExpression(expr) && expr.name.text === 'props';
}

/**
 * 判断表达式是否是 props.children（含 `props['children']`）。
 * @param {ts.Expression} expr
 * @returns {boolean}
 */
function isPropsChildren(expr) {
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text === 'children' && isPropsLike(expr.expression);
  }
  if (ts.isElementAccessExpression(expr)) {
    const key = expr.argumentExpression.getText().replace(/^['"]|['"]$/g, '');
    return key === 'children' && isPropsLike(expr.expression);
  }
  return false;
}

/**
 * 找到最近的属性声明名（用于区分 children 与普通值 prop）。
 * @param {ts.Node} node
 * @returns {string}
 */
function enclosingPropertyName(node) {
  let cur = node.parent;
  while (cur) {
    if (
      (ts.isPropertySignature(cur) || ts.isPropertyDeclaration(cur) || ts.isParameter(cur)) &&
      cur.name
    ) {
      return cur.name.getText().replace(/^['"]|['"]$/g, '');
    }
    cur = cur.parent;
  }
  return '';
}

/**
 * 应用一组文本替换（从后往前，跳过被外层替换覆盖的内层替换）。
 * @param {string} text
 * @param {{start: number, end: number, next: string, kind: string}[]} replacements
 * @returns {{text: string, applied: string[]}}
 */
function applyReplacements(text, replacements) {
  const sorted = [...replacements].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  const applied = [];
  for (const r of sorted) {
    if (applied.some((a) => r.start < a.end && a.start < r.end)) continue;
    out = out.slice(0, r.start) + r.next + out.slice(r.end);
    applied.push(r);
  }
  return { text: out, applied: applied.map((r) => r.kind) };
}

/**
 * 单轮 AST 改写。
 * @param {string} text
 * @param {string} file
 * @param {ReturnType<typeof parseArgs>} options
 * @param {boolean} hasPlainResolve 原始文件是否从 plain 导入了 resolve
 * @returns {{text: string, changes: string[], warnings: object[], parseErrors: string[]}}
 */
function transformAst(text, file, options, hasPlainResolve) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const parseErrors = sf.parseDiagnostics.map((d) => {
    const pos = d.start ?? 0;
    const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
    return `第 ${line} 行：${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
  if (parseErrors.length) {
    return { text, changes: [], warnings: [], parseErrors };
  }

  const replacements = [];
  const warnings = [];
  const add = (start, end, next, kind) => replacements.push({ start, end, next, kind });
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  /** 处理 import：删除 resolve / MaybeGetter。 */
  function handleImport(node) {
    const moduleName = moduleNameOf(node, sf);
    const clause = node.importClause;
    const named = clause?.namedBindings;
    if (!clause || !named || !ts.isNamedImports(named)) return;
    const remove = new Set();
    for (const el of named.elements) {
      if (el.propertyName) {
        if (el.propertyName.text === 'resolve' && PLAIN_MODULES.has(moduleName)) {
          warnings.push({
            line: lineOf(el),
            kind: 'resolve-alias',
            detail: `发现别名导入 ${el.getText(sf)}，请手工删除并改调用点`,
          });
        }
        continue;
      }
      if (el.name.text === 'resolve' && PLAIN_MODULES.has(moduleName)) remove.add('resolve');
      if (el.name.text === 'MaybeGetter') {
        remove.add('MaybeGetter');
        if (!PLAIN_MODULES.has(moduleName)) {
          warnings.push({
            line: lineOf(el),
            kind: 'maybegetter-import',
            detail: `从 '${moduleName}' 导入的 MaybeGetter 已被移除，请确认这是旧类型`,
          });
        }
      }
    }
    if (!remove.size) return;
    const kept = named.elements.filter((el) => !remove.has(el.name.text));
    if (kept.length === named.elements.length) return;

    let next = '';
    const typePrefix = clause.isTypeOnly ? 'type ' : '';
    if (kept.length) {
      const prefix = `import ${typePrefix}${clause.name ? clause.name.getText(sf) + ', ' : ''}`;
      next = `${prefix}{ ${kept.map((el) => el.getText(sf)).join(', ')} } from ` +
        `${node.moduleSpecifier.getText(sf)};`;
    } else if (clause.name) {
      next = `import ${typePrefix}${clause.name.getText(sf)} from ` +
        `${node.moduleSpecifier.getText(sf)};`;
    }
    let end = node.getEnd();
    if (!next) {
      if (text[end] === '\r' && text[end + 1] === '\n') end += 2;
      else if (text[end] === '\n') end += 1;
    }
    add(node.getStart(sf), end, next, 'import');
  }

  /** 处理 resolve(...) 调用。 */
  function handleResolveCall(node) {
    if (!hasPlainResolve || !ts.isCallExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'resolve') return;
    if (node.arguments.length !== 1) {
      warnings.push({
        line: lineOf(node),
        kind: 'resolve-arity',
        detail: `resolve(...) 参数不是 1 个，未自动处理：${node.getText(sf).slice(0, 80)}`,
      });
      return;
    }
    const arg = node.arguments[0];
    if (isPropsChildren(arg)) {
      const objectText = arg.expression.getText(sf);
      add(node.getStart(sf), node.getEnd(), `${objectText}.children?.()`, 'resolve-children');
      return;
    }
    const argText = arg.getText(sf);
    const next = SIMPLE_KINDS.has(arg.kind) ? argText : `(${argText})`;
    add(node.getStart(sf), node.getEnd(), next, 'resolve');
  }

  /** 处理 MaybeGetter<T> 类型引用。 */
  function handleMaybeGetterType(node) {
    if (!ts.isTypeReferenceNode(node)) return;
    const typeName = node.typeName.getText(sf);
    if (typeName !== 'MaybeGetter' && !typeName.endsWith('.MaybeGetter')) return;
    if (!node.typeArguments || node.typeArguments.length !== 1) {
      warnings.push({
        line: lineOf(node),
        kind: 'maybegetter-generic',
        detail: `MaybeGetter 缺少类型参数，未自动处理：${node.getText(sf)}`,
      });
      return;
    }
    const typeArg = node.typeArguments[0];
    const needsParens =
      ts.isUnionTypeNode(typeArg) ||
      ts.isIntersectionTypeNode(typeArg) ||
      ts.isFunctionTypeNode(typeArg);
    const inner = needsParens ? `(${typeArg.getText(sf)})` : typeArg.getText(sf);
    let next = inner;
    if (enclosingPropertyName(node) === 'children') next = `() => ${inner}`;
    add(node.getStart(sf), node.getEnd(), next, 'MaybeGetter');
  }

  /** 处理 Renderable | (() => Renderable)。 */
  function handleRenderableUnion(node) {
    if (!ts.isUnionTypeNode(node)) return;
    const parts = node.types.map((t) => t.getText(sf).trim());
    const fnText = parts.find((t) => /^\(?\(\s*\)\s*=>\s*Renderable\)?$/.test(t));
    if (!parts.includes('Renderable') || !fnText) return;
    const rest = parts.filter((t) => t !== 'Renderable' && t !== fnText);
    let next;
    if (enclosingPropertyName(node) === 'children') {
      next = rest.length ? `(() => Renderable) | ${rest.join(' | ')}` : '() => Renderable';
    } else {
      next = ['Renderable', ...rest].join(' | ');
    }
    add(node.getStart(sf), node.getEnd(), next, 'Renderable-union');
  }

  /** 处理 JSX 零参箭头属性。 */
  function handleJsxAttribute(node) {
    if (!node.initializer || !ts.isJsxExpression(node.initializer)) return;
    const expr = node.initializer.expression;
    if (!expr || !ts.isArrowFunction(expr) || expr.parameters.length || ts.isBlock(expr.body)) {
      return;
    }
    const name = node.name.getText(sf);
    if (/^on/i.test(name) || name === 'ref' || name === 'render' || name === 'children') return;
    if (name === 'fallback' || name === 'key') return;

    const attrs = node.parent;
    const opening = attrs?.parent;
    const tagName =
      opening && (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))
        ? opening.tagName.getText(sf)
        : '';
    const isNative = /^[a-z]/.test(tagName) || tagName.includes('-');
    if (!isNative && !options.valueProps.has(name)) {
      warnings.push({
        line: lineOf(node),
        kind: 'jsx-arrow',
        detail: `${tagName || '?'} 的 ${name}={() => …} 未改写，确认它是 render prop 还是值 prop`,
      });
      return;
    }
    add(expr.getStart(sf), expr.getEnd(), expr.body.getText(sf), 'jsx-arrow');
  }

  /** 检测本地 MaybeGetter 类型别名（0.4 已删除该类型）。 */
  function handleTypeAlias(node) {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'MaybeGetter') {
      warnings.push({
        line: lineOf(node),
        kind: 'maybegetter-alias',
        detail: '本地仍定义 MaybeGetter 类型别名；0.4 已删除该类型，请删除或改名',
      });
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) handleImport(node);
    if (ts.isCallExpression(node)) handleResolveCall(node);
    if (ts.isTypeReferenceNode(node)) handleMaybeGetterType(node);
    if (ts.isUnionTypeNode(node)) handleRenderableUnion(node);
    if (ts.isJsxAttribute(node)) handleJsxAttribute(node);
    if (ts.isTypeAliasDeclaration(node)) handleTypeAlias(node);
    ts.forEachChild(node, visit);
  }
  visit(sf);

  const result = applyReplacements(text, replacements);
  return { text: result.text, changes: result.applied, warnings, parseErrors: [] };
}

/**
 * 清理失效的 `PLAIN_E1108` / 旧短名抑制指令。
 * @param {string} text
 * @returns {{text: string, removed: number}}
 */
function stripStaleSuppressions(text) {
  let removed = 0;
  const lineRe = new RegExp(
    '^([^\\r\\n]*?)(\\/\\/\\s*|\\/\\*\\s*)(plain-ignore-(?:line|next-line))' +
    '([^*\\r\\n]*?)(\\*\\/)?[ \\t]*$',
    'gm'
  );
  const out = text.replace(lineRe, (full, before, opener, directive, codes, closer) => {
    const tokens = codes.trim().split(/\s+/).filter(Boolean);
    const kept = tokens.filter((t) => t !== 'PLAIN_E1108' && t !== 'plain/no-resolve-event-prop');
    if (kept.length === tokens.length) return full;
    removed++;
    // 只保留真正的规则码；没有规则码就把整条抑制注释删掉，避免退化成「抑制全部」。
    const codesLeft = kept.filter((t) => /^PLAIN_E\d+$/.test(t) || /^plain\//.test(t));
    if (!codesLeft.length) return before.replace(/[ \t]+$/, '');
    const open = opener.startsWith('/*') ? '/* ' : '// ';
    const tail = closer ? ` ${closer}` : '';
    return `${before}${open}${directive} ${codesLeft.join(' ')}${tail}`;
  });
  return { text: out, removed };
}

/**
 * 在纯文本里展开 `name={() => expr}`（用于代码示例字符串）。
 * @param {string} text
 * @param {Set<string>} names
 * @returns {string}
 */
function unwrapArrowsInText(text, names) {
  let out = text;
  for (const name of names) {
    const needle = `${name}={()`;
    let index = out.indexOf(needle);
    while (index !== -1) {
      const braceStart = index + name.length + 1;
      const arrow = out.indexOf('=>', braceStart);
      if (arrow === -1) break;
      const params = out.slice(braceStart + 1, arrow).trim();
      if (!/^\(\s*\)$/.test(params)) {
        index = out.indexOf(needle, index + needle.length);
        continue;
      }
      let depth = 0;
      let end = -1;
      for (let i = braceStart; i < out.length; i++) {
        const ch = out[i];
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') {
          depth--;
          if (ch === '}' && depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) break;
      const body = out.slice(arrow + 2, end).trim();
      out = out.slice(0, braceStart + 1) + body + out.slice(end);
      index = out.indexOf(needle, braceStart + 1 + body.length);
    }
  }
  return out;
}

/**
 * 改写字符串 / 模板字符串里的代码示例（可选）。
 * @param {string} text
 * @param {string} file
 * @param {Set<string>} valueProps
 * @returns {{text: string, count: number}}
 */
function rewriteCodeSamples(text, file, valueProps) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  if (sf.parseDiagnostics.length) return { text, count: 0 };
  const names = new Set([...valueProps, ...SAMPLE_NATIVE_PROPS]);
  const replacements = [];
  function visit(node) {
    const isCodeString =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
    if (isCodeString) {
      const raw = node.getText(sf);
      const inner = raw.slice(1, -1);
      // 只处理看起来像 JSX 代码片段的字符串，避免误改用户文案。
      if (/<[A-Za-z]/.test(inner) && /\(\s*\)\s*=>/.test(inner)) {
        const next = unwrapArrowsInText(inner, names);
        if (next !== inner) {
          replacements.push({
            start: node.getStart(sf) + 1,
            end: node.getEnd() - 1,
            next,
            kind: 'code-sample',
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  const result = applyReplacements(text, replacements);
  return { text: result.text, count: result.applied.length };
}

/**
 * 收集仍提到旧写法的注释，供人工确认（不自动改注释，避免改坏历史说明）。
 * @param {string} text
 * @returns {{line: number, detail: string}[]}
 */
function findStaleCommentMentions(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (!/\bresolve\s*\(|\bMaybeGetter\b|PLAIN_E1108/.test(line)) continue;
    hits.push({ line: i + 1, detail: line.trim().slice(0, 100) });
  }
  return hits;
}

/**
 * 判断文件是否从 plain 导入了未别名的 resolve。
 * @param {string} text
 * @param {string} file
 * @returns {boolean}
 */
function importsPlainResolve(text, file) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !PLAIN_MODULES.has(moduleNameOf(stmt, sf))) continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (el.name.text === 'resolve' && !el.propertyName) return true;
    }
  }
  return false;
}

/**
 * 多轮改写会产生重复告警，这里按内容去重。
 * @param {object[]} warnings
 * @returns {object[]}
 */
function dedupeWarnings(warnings) {
  const seen = new Set();
  return warnings.filter((w) => {
    const key = `${w.kind}:${w.line ?? ''}:${w.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 迁移单个源码字符串（纯函数，供命令行与测试共用）。
 * @param {string} text 源码
 * @param {string} file 文件路径（只用于推断解析模式与报行号）
 * @param {ReturnType<typeof parseArgs>} options
 * @returns {{text: string, changes: string[], warnings: object[], skipped: boolean}}
 */
export function migrateSource(text, file, options) {
  let current = text;
  const changes = [];
  const warnings = [];
  const hasPlainResolve = importsPlainResolve(text, file);
  for (let pass = 0; pass < 5; pass++) {
    const result = transformAst(current, file, options, hasPlainResolve);
    if (result.parseErrors.length) {
      return {
        text,
        changes: [],
        warnings: [{
          kind: 'parse-error',
          detail: `语法解析失败，已跳过：${result.parseErrors.join('；')}`,
        }],
        skipped: true,
      };
    }
    warnings.push(...result.warnings);
    if (!result.changes.length) break;
    current = result.text;
    changes.push(...result.changes);
  }

  const stripped = stripStaleSuppressions(current);
  if (stripped.removed) {
    current = stripped.text;
    changes.push(...Array(stripped.removed).fill('stale-suppression'));
  }

  if (options.codeSamples) {
    const samples = rewriteCodeSamples(current, file, options.valueProps);
    if (samples.count) {
      current = samples.text;
      changes.push(...Array(samples.count).fill('code-sample'));
    }
  }

  // 删除 import 后可能残留的文件首行空行（原本没有空行时才清理）。
  if (!/^[\r\n]/.test(text) && /^\r?\n/.test(current)) {
    current = current.replace(/^(?:\r?\n)+/, '');
  }

  for (const hit of findStaleCommentMentions(current)) {
    warnings.push({
      line: hit.line,
      kind: 'stale-comment',
      detail: `注释仍提到旧写法，请人工确认：${hit.detail}`,
    });
  }
  return { text: current, changes, warnings: dedupeWarnings(warnings), skipped: false };
}

/**
 * 命令行入口。
 * @returns {void}
 */
function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[migrate] ${error.message}`);
    printUsage();
    process.exitCode = 2;
    return;
  }
  if (!options.targets.length) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const files = [];
  for (const target of options.targets) {
    try {
      files.push(...collectFiles(target));
    } catch (error) {
      console.error(`[migrate] ${error.message}`);
      process.exitCode = 2;
      return;
    }
  }

  let changedFiles = 0;
  let totalChanges = 0;
  let skippedFiles = 0;
  const warnings = [];
  for (const file of files) {
    const relative = path.relative(process.cwd(), file);
    const rel = relative && !relative.startsWith('..') ? relative : file;
    let original;
    try {
      original = fs.readFileSync(file, 'utf8');
    } catch (error) {
      console.error(`[migrate] 读取失败 ${rel}：${error.message}`);
      process.exitCode = 1;
      continue;
    }
    const result = migrateSource(original, file, options);
    if (result.skipped) {
      skippedFiles++;
      warnings.push(...result.warnings.map((w) => ({ ...w, file: rel })));
      continue;
    }
    warnings.push(...result.warnings.map((w) => ({ ...w, file: rel })));
    if (result.text === original) continue;
    changedFiles++;
    totalChanges += result.changes.length;
    if (!options.dryRun) {
      try {
        fs.writeFileSync(file, result.text, 'utf8');
      } catch (error) {
        console.error(`[migrate] 写入失败 ${rel}：${error.message}`);
        process.exitCode = 1;
        continue;
      }
    }
    if (!options.quiet) {
      console.log(`${options.dryRun ? '将修改' : '✓'} ${rel}（${result.changes.length} 处）`);
    }
  }

  console.log(
    `\n[migrate] 扫描 ${files.length} 个文件，` +
    `${options.dryRun ? '将修改' : '已修改'} ${changedFiles} 个，` +
    `自动改写 ${totalChanges} 处` +
    (skippedFiles ? `，跳过 ${skippedFiles} 个（语法解析失败）` : '') +
    '。'
  );
  if (options.dryRun) console.log('[migrate] 当前是 --dry-run，未写盘。');

  if (warnings.length) {
    console.log(`\n[migrate] ${warnings.length} 项需人工确认：`);
    warnings.slice(0, 40).forEach((w) => {
      const where = w.line ? `${w.file}:${w.line}` : w.file;
      console.log(`  - ${where}  [${w.kind}] ${w.detail}`);
    });
    if (warnings.length > 40) console.log(`  … 其余 ${warnings.length - 40} 项省略`);
    console.log('\n处理完后请按 docs/migrate-0.3-to-0.4.md 第 6 步验证。');
  }
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
