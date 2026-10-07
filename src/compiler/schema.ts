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

export function extractSchema(source: string, fileName = "module.tsx"): ExtractedSchema {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind(fileName));
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
    const props: any[] = [];
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

    Array.from(new Set([...usedProps, ...callSites]))
      .filter((p) => p !== "children")
      .forEach((p) => props.push({ name: p, optional: !callSites.has(p) }));

    const elements = new Set<string>();
    const collectTags = (node: any) => {
      if (ts.isJsxElement(node) && !isComponentTag(node.openingElement.tagName.getText(sf)))
        elements.add(node.openingElement.tagName.getText(sf));
      if (ts.isJsxSelfClosingElement(node) && !isComponentTag(node.tagName.getText(sf)))
        elements.add(node.tagName.getText(sf));
      ts.forEachChild(node, collectTags);
    };
    collectTags(jsx);

    out.components.push({
      name,
      line: sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1,
      props,
      hasChildren: usedProps.has("children"),
      renders: Array.from(elements).sort(),
    });
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
