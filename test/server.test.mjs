// server 单测：dom-shim / SSR 序列化与转义 / staticMiddleware（含穿越与 SPA 兜底）/
//            rpcMiddleware（handlers / manifest / 各错误码）/ serve 一行起服务
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToString, renderToStringSync } from "../dist/server/render.js";
import { installServerDOM, serializeNode } from "../dist/server/dom-shim.js";
import { rpcMiddleware, staticMiddleware, serve } from "../dist/server/index.js";
import { renderServerManifest, updateServerManifest } from "../dist/compiler/manifest.js";

const tmpDir = (prefix = "plain-srv-") =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function fakeResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(body) {
      this.body = body;
      if (this._resolve) this._resolve();
    },
  };
  res.done = new Promise((r) => {
    res._resolve = r;
  });
  return res;
}

function fakeRequest({ method = "GET", url = "/" } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  return req;
}

async function call(mw, { method = "GET", url = "/", payload } = {}) {
  const req = fakeRequest({ method, url });
  const res = fakeResponse();
  mw(req, res, () => {
    res.nextCalled = true;
    if (res._resolve) res._resolve();
  });
  if (payload !== undefined) req.emit("data", Buffer.from(JSON.stringify(payload)));
  req.emit("end");
  await res.done;
  return res;
}

// ---------------------------------------------------------------------------
// dom-shim + SSR
// ---------------------------------------------------------------------------

test("SSR 序列化：文本/属性转义、void 标签、样式、认领锚点输出而普通注释不输出", () => {
  const doc = installServerDOM();
  const box = doc.createElement("div");
  box.setAttribute("class", 'a"b');
  box.appendChild(doc.createTextNode("<b>&</b>"));
  box.appendChild(doc.createElement("input"));
  box.appendChild(doc.createElement("br"));
  // 普通注释：丢弃
  box.appendChild(doc.createComment("[anchor]"));
  // 认领锚点（plain- 前缀）：必须原样输出，hydrate 靠它定位
  box.appendChild(doc.createComment("plain-["));
  const img = doc.createElement("img");
  img.style.backgroundColor = "red";
  box.appendChild(img);

  assert.equal(
    renderToStringSync(box),
    '<div class="a&quot;b">&lt;b&gt;&amp;&lt;/b&gt;<input><br><!--plain-[--><img style="background-color:red"></div>'
  );
});

test("dom-shim：innerHTML 是硬红线，直接抛错", () => {
  const doc = installServerDOM();
  assert.throws(() => {
    doc.createElement("div").innerHTML = "<b>x</b>";
  }, /禁止.*innerHTML/);
});

test("dom-shim：children/textContent/contains/remove + serializeNode 边界", () => {
  const doc = installServerDOM();
  const p = doc.createElement("p");
  const span = doc.createElement("span");
  p.appendChild(span);
  p.appendChild(doc.createTextNode("text"));
  assert.equal(p.children.length, 1);
  assert.equal(p.textContent, "<span></span>text");
  assert.equal(p.contains(span), true);
  span.remove();
  assert.equal(p.children.length, 0);
  p.textContent = "";
  assert.equal(p.childNodes.length, 0);

  assert.equal(serializeNode(null), "");
  assert.equal(serializeNode({ nodeType: 99 }), "");
  assert.equal(doc.querySelector("x"), null);
  assert.equal(doc.getElementById("x"), null);
  assert.equal(doc.createElementNS("ns", "b").tagName, "b");
});

test("renderToString：container 包裹开关 + 异步 wait", async () => {
  const build = () => {
    const d = globalThis.document;
    const section = d.createElement("section");
    section.appendChild(d.createTextNode("hi"));
    return section;
  };
  assert.equal(await renderToString(build, { container: false }), "<section>hi</section>");
  assert.equal(await renderToString(build), "<div><section>hi</section></div>");
  assert.equal(
    await renderToString(build, { wait: 5, container: false }),
    "<section>hi</section>"
  );
  assert.equal(await renderToString(null, { container: false }), "");
});

// ---------------------------------------------------------------------------
// staticMiddleware
// ---------------------------------------------------------------------------

function makeSite() {
  const base = tmpDir("plain-site-");
  const root = path.join(base, "dist");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<html>INDEX</html>");
  fs.writeFileSync(path.join(root, "app.js"), "console.log(1);");
  fs.writeFileSync(path.join(root, "sub", "index.html"), "<html>SUB</html>");
  fs.writeFileSync(path.join(base, "secret.txt"), "TOP SECRET");
  return { base, root };
}

test("staticMiddleware：静态文件 / 目录 / SPA 兜底 / 404", async () => {
  const { root } = makeSite();
  const mw = staticMiddleware(root, { spa: true });

  const js = await call(mw, { url: "/app.js?v=1" });
  assert.equal(js.statusCode, 200);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(js.body.toString(), "console.log(1);");

  const index = await call(mw, { url: "/" });
  assert.equal(index.statusCode, 200);
  assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(index.body.toString(), "<html>INDEX</html>");

  const dirIndex = await call(mw, { url: "/sub" });
  assert.equal(dirIndex.body.toString(), "<html>SUB</html>");

  // 无扩展名 => 看起来像页面导航 => 走 SPA 兜底
  const spa = await call(mw, { url: "/nope/xxx" });
  assert.equal(spa.statusCode, 200);
  assert.equal(spa.body.toString(), "<html>INDEX</html>");

  // 带扩展名的资源该 404 就 404，不能吞成 HTML
  const missingAsset = await call(mw, { url: "/nope.js" });
  assert.equal(missingAsset.statusCode, 404);
  assert.equal(missingAsset.body.toString(), "Not Found");
});

test("staticMiddleware：spa:false 时不兜底", async () => {
  const { root } = makeSite();
  const mw = staticMiddleware(root, { spa: false });
  const r = await call(mw, { url: "/nope/xxx" });
  assert.equal(r.statusCode, 404);
});

test("staticMiddleware：非法 URL 返回 400，目录穿越拿不到外部文件", async () => {
  const { root } = makeSite();
  const mw = staticMiddleware(root, { spa: true });

  const nul = await call(mw, { url: "/a%00b" });
  assert.equal(nul.statusCode, 400);

  const bad = await call(mw, { url: "/%E0%A4%A" });
  assert.equal(bad.statusCode, 400);

  for (const url of ["/../secret.txt", "/%2e%2e/secret.txt", "/sub/../../secret.txt"]) {
    const r = await call(mw, { url });
    assert.notEqual(r.body.toString(), "TOP SECRET", `不得读到 root 之外的文件：${url}`);
  }
});

// ---------------------------------------------------------------------------
// rpcMiddleware
// ---------------------------------------------------------------------------

test("rpcMiddleware：url 不匹配时交还给 next", async () => {
  const mw = rpcMiddleware({ handlers: {} });
  const r = await call(mw, { url: "/other" });
  assert.equal(r.nextCalled, true);
});

test("rpcMiddleware：非 POST -> 405", async () => {
  const mw = rpcMiddleware({ handlers: {} });
  const r = await call(mw, { method: "GET", url: "/_plain/rpc" });
  assert.equal(r.statusCode, 405);
});

test("rpcMiddleware：内置 handlers 直连；未知函数 404；抛错 500；undefined -> null", async () => {
  const mw = rpcMiddleware({
    handlers: {
      echo: (x) => x,
      boom: () => {
        throw new Error("后端炸了");
      },
      nothing: () => undefined,
    },
  });

  const ok = await call(mw, { method: "POST", url: "/_plain/rpc", payload: { name: "echo", args: ["hi"] } });
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).result, "hi");

  const unknown = await call(mw, { method: "POST", url: "/_plain/rpc", payload: { name: "nope" } });
  assert.equal(unknown.statusCode, 404);
  assert.match(JSON.parse(unknown.body).error, /unknown server fn/);

  const boom = await call(mw, { method: "POST", url: "/_plain/rpc", payload: { name: "boom" } });
  assert.equal(boom.statusCode, 500);
  assert.match(JSON.parse(boom.body).error, /后端炸了/);

  const none = await call(mw, { method: "POST", url: "/_plain/rpc", payload: { name: "nothing" } });
  assert.equal(JSON.parse(none.body).result, null);
});

test("rpcMiddleware：从 .plain/server.mjs 清单加载处理器", async () => {
  const dir = tmpDir();
  const manifest = path.join(dir, "server.mjs");
  fs.writeFileSync(
    manifest,
    renderServerManifest([{ name: "ping", body: "() => 'pong'" }])
  );
  const mw = rpcMiddleware({ manifest });
  const r = await call(mw, { method: "POST", url: "/_plain/rpc", payload: { name: "ping", args: [] } });
  assert.equal(JSON.parse(r.body).result, "pong");
});

test("renderServerManifest：同名 server 函数来自不同文件 -> 抛冲突错误并点名两处来源", () => {
  assert.throws(
    () =>
      renderServerManifest([
        { name: "load", body: "() => 1", from: "/app/routes/a.tsx" },
        { name: "load", body: "() => 2", from: "/app/routes/b.tsx" },
      ]),
    (err) => {
      assert.match(err.message, /函数名冲突/);
      assert.match(err.message, /a\.tsx/);
      assert.match(err.message, /b\.tsx/);
      return true;
    }
  );
});

test("renderServerManifest：同名但同一来源（增量重复）不算冲突", () => {
  const src = renderServerManifest([
    { name: "load", body: "() => 1", from: "/app/a.tsx" },
    { name: "load", body: "() => 2", from: "/app/a.tsx" },
  ]);
  assert.match(src, /export const load = \(\) => 2;/, "同来源取最后一条");
});

test("renderServerManifest：无来源信息的同名条目按冲突处理（兜底不静默覆盖）", () => {
  assert.throws(
    () =>
      renderServerManifest([
        { name: "load", body: "() => 1" },
        { name: "load", body: "() => 2" },
      ]),
    /函数名冲突[\s\S]*未知来源/
  );
});

test("updateServerManifest：跨文件同名的增量更新被拦下", () => {
  const dir = tmpDir();
  const manifest = path.join(dir, "server.mjs");
  updateServerManifest(
    [{ name: "load", body: "() => 1", from: "/app/a.tsx" }],
    manifest
  );
  // 清单本身不携带来源，增量更新时来源信息来自调用方传入的 entries；
  // 这里同一次调用里带上两条跨文件同名，应被 assertNoNameCollision 拦下。
  assert.throws(
    () =>
      updateServerManifest(
        [
          { name: "x", body: "() => 1", from: "/app/a.tsx" },
          { name: "x", body: "() => 2", from: "/app/b.tsx" },
        ],
        manifest
      ),
    /函数名冲突/
  );
});

test("rpcMiddleware：清单缺失时给出可读的 500（而不是静默成功）", async () => {  const mw = rpcMiddleware({ manifest: path.join(tmpDir(), "nope.mjs") });
  const r = await call(mw, { method: "POST", url: "/_plain/rpc", payload: { name: "x" } });
  assert.equal(r.statusCode, 500);
  assert.match(JSON.parse(r.body).error, /找不到服务端清单/);
});

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

test("serve：一行起服，静态托管 + RPC 走通", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "index.html"), "<html>SERVED</html>");
  const manifest = path.join(dir, "server.mjs");
  fs.writeFileSync(manifest, renderServerManifest([{ name: "v", body: "() => 42" }]));

  const server = await serve({ dist: dir, manifest, port: 0 });
  const { port } = server.address();
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /SERVED/);

    const rpc = await fetch(`http://127.0.0.1:${port}/_plain/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "v", args: [] }),
    });
    assert.equal((await rpc.json()).result, 42);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
