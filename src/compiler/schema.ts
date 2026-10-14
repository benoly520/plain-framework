// 组件契约提取：给 AI / IDE / CI 用的机器可读摘要
//
// 产出 JSON：每个组件有哪些 props、哪些 state、哪些 server 函数、哪些路由。
// Agent 拿到这个就知道「能改什么」，不用通读全文。

import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

export interface ExtractedSchema {
  file: string;
  components: any[];
  serverFunctions: any[];
  routes: any[];
  exports: any[];
  imports: any[];
}

function kind(name: string): ts.ScriptKind {
  if (/\.tsx$/.test(name)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(name)) return ts.ScriptKind.JSX;
  if (/\.ts$/.test(name)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function isJsxLike(n: any): boolean {
  return (
    n &&
    (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n))
  );
}

/** 比较两组 props 是否等价（只看名字 + 是否可选） */
function sameProps(a: any[], b: any[]): boolean {
  if (a.length !== b.length) return false;
  const key = (p: any) => `${p.name}:${p.optional ? "?" : ""}`;
  const other = new Set(b.map(key));
  return a.every((p) => other.has(key(p)));
}

/** 收集本文件的 interface / type 声明（props 类型的解析来源） */
function collectTypeDecls(sf: ts.SourceFile): Map<string, any> {
  const map = new Map<string, any>();
  const visit = (node: any) => {
    if (ts.isInterfaceDeclaration(node)) map.set(node.name.text, node);
    else if (ts.isTypeAliasDeclaration(node) && ts.isIdentifier(node.name))
      map.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

/** 类型成员 -> props 条目 { name, optional, type } */
function membersToProps(members: any[], sf: ts.SourceFile): any[] {
  const out: any[] = [];
  for (const m of members) {
    if (!m.name) continue;
    const name = m.name.getText(sf).replace(/^['"]|['"]$/g, "");
    if (out.some((p) => p.name === name)) continue;
    const type = ts.isMethodSignature(m) ? "method" : m.type ? m.type.getText(sf) : "any";
    out.push({ name, optional: !!m.questionToken, type });
  }
  return out;
}

/**
 * 把 props 的类型注解解析成成员列表。
 *
 * 只解析**本文件内**的 `interface` / `type 字面量`，以及它们的 `extends` / `&` 组合；
 * 跨文件、泛型、工具类型（`Pick<…>` / `Omit<…>`）等一律解析不了 -> 返回 `null`，
 * 由调用方标记 `propsSource: "declared-unresolved"` 并附上类型名 —— **不假装解析成功**。
 */
function resolveTypeMembers(
  type: any,
  decls: Map<string, any>,
  seen = new Set<string>()
): any[] | null {
  if (!type) return null;
  if (ts.isTypeLiteralNode(type)) return Array.from(type.members);
  if (ts.isIntersectionTypeNode(type)) {
    const all: any[] = [];
    for (const t of type.types) {
      const m = resolveTypeMembers(t, decls, seen);
      if (!m) return null;
      all.push(...m);
    }
    return all;
  }
  const refName =
    ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)
      ? type.typeName.text
      : ts.isExpressionWithTypeArguments(type) && ts.isIdentifier(type.expression)
        ? type.expression.text
        : null;
  // seen 只挡「当前这条路径」上的自引用，别误伤菱形继承
  if (!refName || seen.has(refName)) return null;
  const decl = decls.get(refName);
  if (!decl) return null;
  seen.add(refName);
  let result: any[] | null = null;
  if (ts.isTypeAliasDeclaration(decl)) {
    result = resolveTypeMembers(decl.type, decls, seen);
  } else if (ts.isInterfaceDeclaration(decl)) {
    let members: any[] = Array.from(decl.members);
    let failed = false;
    for (const h of decl.heritageClauses || []) {
      for (const t of h.types) {
        const inherited = resolveTypeMembers(t, decls, seen);
        if (!inherited) {
          failed = true;
          break;
        }
        members = members.concat(inherited);
      }
      if (failed) break;
    }
    // 基类解析不了 -> 整个 props 集合就是未知的，不能只报自己那几个（诚实优先）
    result = failed ? null : members;
  }
  seen.delete(refName);
  return result;
}

export function extractSchema(source: string, fileName = "module.tsx"): ExtractedSchema {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind(fileName));
  // 本文件的 interface / type 声明 —— props 的「声明式」事实来源（见 resolveTypeMembers）
  const typeDecls = collectTypeDecls(sf);
  const out: ExtractedSchema = {
    file: fileName,
    components: [],
    serverFunctions: [],
    routes: [],
    exports: [],
    imports: [],
  };

  const jsxBodyOf = (fn: any) => {
    const unwrap = (n: any) => {
      let e = n;
      while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)))
        e = e.expression;
      return e;
    };
    const body = unwrap(fn.body);
    if (isJsxLike(body)) return body;
    if (ts.isBlock(body)) {
      const r = body.statements.find(
        (s: any) => ts.isReturnStatement(s) && s.expression && isJsxLike(unwrap(s.expression))
      );
      return r ? unwrap((r as any).expression) : null;
    }
    return null;
  };

  const describeComponent = (nameNode: any, fn: any) => {
    const jsx = jsxBodyOf(fn);
    if (!jsx) return;
    const name = nameNode && nameNode.getText ? nameNode.getText(sf) : null;
    if (!name) return;
    const propsObj =
      fn.parameters && fn.parameters[0] ? fn.parameters[0].name : null;
    const usedProps = new Set<string>();
    // props.xxx / props.children 的使用
    const scanProps = (node: any) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        propsObj &&
        ts.isIdentifier(propsObj) &&
        node.expression.text === propsObj.text
      ) {
        usedProps.add(node.name.text);
      }
      // const { title, value } = props
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        propsObj &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === propsObj.text
      ) {
        node.name.elements.forEach((e: any) => {
          if (ts.isIdentifier(e.name)) usedProps.add(e.name.text);
        });
      }
      ts.forEachChild(node, scanProps);
    };
    if (fn.body) scanProps(fn.body);

    // 调用点上传了哪些属性
    const callSites = new Set<string>();
    const collectCalls = (node: any) => {
      if (
        ts.isJsxSelfClosingElement(node) &&
        isComponentTag(node.tagName.getText(sf)) &&
        node.tagName.getText(sf) === name
      ) {
        node.attributes.properties.forEach((p: any) => {
          if (ts.isJsxAttribute(p)) callSites.add(p.name.getText(sf));
        });
      }
      if (
        ts.isJsxElement(node) &&
        isComponentTag(node.openingElement.tagName.getText(sf)) &&
        node.openingElement.tagName.getText(sf) === name
      ) {
        node.openingElement.attributes.properties.forEach((p: any) => {
          if (ts.isJsxAttribute(p)) callSites.add(p.name.getText(sf));
        });
      }
      ts.forEachChild(node, collectCalls);
    };
    collectCalls(sf);

    // 「猜」出来的 props：代码里读了什么 + 同文件调用点传了什么（只有名字，没有类型）
    const inferredProps = Array.from(new Set([...usedProps, ...callSites]))
      .filter((p) => p !== "children")
      .map((p) => ({ name: p, optional: !callSites.has(p) }));

    // 「声明」的 props：组件的参数类型注解 —— 这才是契约的事实来源
    const param = fn.parameters && fn.parameters[0];
    const paramType = param && param.type;
    const declaredType = paramType ? paramType.getText(sf) : null;
    const members = paramType ? resolveTypeMembers(paramType, typeDecls) : null;
    const declaredAll = members ? membersToProps(members, sf) : null;
    const declaredProps = declaredAll
      ? declaredAll.filter((p) => p.name !== "children")
      : null;

    const elements = new Set<string>();
    const collectTags = (node: any) => {
      if (ts.isJsxElement(node) && !isComponentTag(node.openingElement.tagName.getText(sf)))
        elements.add(node.openingElement.tagName.getText(sf));
      if (ts.isJsxSelfClosingElement(node) && !isComponentTag(node.tagName.getText(sf)))
        elements.add(node.tagName.getText(sf));
      ts.forEachChild(node, collectTags);
    };
    collectTags(jsx);

    const comp: any = {
      name,
      line: sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1,
      // 权威列表：声明可得就用声明，否则退回推断
      props: declaredProps ?? inferredProps,
      propsSource: declaredProps
        ? "declared"
        : declaredType
          ? "declared-unresolved"
          : "inferred",
      hasChildren:
        usedProps.has("children") ||
        (declaredAll ? declaredAll.some((p) => p.name === "children") : false),
      renders: Array.from(elements).sort(),
    };
    // 声明了类型却解析不出来（跨文件 / 泛型 / 工具类型）：带上类型名，不假装
    if (!declaredProps && declaredType) comp.declaredType = declaredType;
    // 两边不一致时把推断结果留在旁边做对照（AI 能一眼看出「猜」错在哪）
    if (declaredProps && !sameProps(declaredProps, inferredProps)) {
      comp.inferredProps = inferredProps;
    }
    out.components.push(comp);
  };

  const visit = (node: any) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      describeComponent(node.name, node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      describeComponent(node.name, node.initializer);
    }

    // server(fn)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "server" &&
      node.arguments.length &&
      (ts.isArrowFunction(node.arguments[0]) ||
        ts.isFunctionExpression(node.arguments[0]))
    ) {
      let decl = node.parent;
      while (decl && !ts.isVariableDeclaration(decl)) decl = decl.parent;
      const fnNode = node.arguments[0];
      out.serverFunctions.push({
        name: decl && ts.isIdentifier(decl.name) ? decl.name.text : null,
        params: fnNode.parameters.map((p: any) => p.name.getText(sf)),
        async: !!fnNode.modifiers?.some(
          (m: any) => m.kind === ts.SyntaxKind.AsyncKeyword
        ),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }

    // createRouter({ routes: [...] })
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createRouter" &&
      node.arguments.length
    ) {
      const arg = node.arguments[0];
      if (ts.isObjectLiteralExpression(arg)) {
        const p = arg.properties.find(
          (x: any) => x.name && x.name.getText(sf) === "routes"
        );
        if (p && ts.isPropertyAssignment(p) && ts.isArrayLiteralExpression(p.initializer)) {
          p.initializer.elements.forEach((el: any) => {
            if (ts.isObjectLiteralExpression(el)) {
              const pathProp = el.properties.find(
                (x: any) => x.name && x.name.getText(sf) === "path"
              );
              const cmpProp = el.properties.find(
                (x: any) => x.name && x.name.getText(sf) === "component"
              );
              out.routes.push({
                path:
                  pathProp && ts.isPropertyAssignment(pathProp)
                    ? String(pathProp.initializer.getText(sf)).replace(/['"]/g, "")
                    : "*",
                component:
                  cmpProp && ts.isPropertyAssignment(cmpProp)
                    ? cmpProp.initializer.getText(sf)
                    : null,
              });
            }
          });
        }
      }
    }

    if (ts.isImportDeclaration(node)) {
      out.imports.push(node.moduleSpecifier.getText(sf).replace(/['"]/g, ""));
    }
    if (
      ts.isExportDeclaration(node) ||
      node.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const name =
        (node.name && node.name.text) ||
        (ts.isExportDeclaration(node) ? "*" : null);
      if (name) out.exports.push(name);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}

function isComponentTag(n: string): boolean {
  return /^[A-Z]/.test(n) || n.includes(".");
}

/** 扫描目录产出整个项目的契约 */
export function scanProject(
  rootDir: string,
  { exts = /\.(tsx|jsx)$/, ignore = /node_modules|\.plain|dist/ } = {}
): any {
  const files: string[] = [];
  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (ignore.test(p)) continue;
      if (entry.isDirectory()) walkDir(p);
      else if (exts.test(entry.name)) files.push(p);
    }
  };
  walkDir(rootDir);
  const schema: any = {
    version: 1,
    framework: "plain",
    root: path.resolve(rootDir),
    files: [],
  };
  for (const f of files) {
    const s = extractSchema(fs.readFileSync(f, "utf8"), path.relative(rootDir, f));
    if (s.components.length || s.serverFunctions.length || s.routes.length) {
      schema.files.push(s);
    }
  }
  return schema;
}
