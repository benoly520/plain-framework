import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mount, hydrate } from '../dist/runtime/index.js';
import { renderToStringWithData, renderToStringSync } from '../dist/server/render.js';
import { runSSR } from '../dist/server/ssr-scope.js';
import { getRuntimeInfo, getRootInfo } from 'plain/runtime-info';

/** 创建并安装测试文档，不依赖浏览器全局变量推断服务端阶段。 */
function setup(html) {
  const dom = new JSDOM(`<div id="app">${html}</div><div id="other"></div>`);
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.Node = dom.window.Node;
  globalThis.Element = dom.window.Element;
  return dom;
}

test('显式查询快照只读；SSR 跨 await、并发及异常后阶段隔离', async () => {
  assert.equal('__plain_runtime__' in globalThis, false);
  const runtime = getRuntimeInfo();
  assert.equal(runtime.schemaVersion, 1);
  assert.equal('version' in runtime, false);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(runtime.frameworkVersion, pkg.version);
  assert.throws(() => { runtime.frameworkVersion = 'invalid'; }, TypeError);
  assert.equal(runtime.environment, 'server');
  assert.equal(getRuntimeInfo().phase, 'idle');
  assert.throws(() => { getRuntimeInfo().phase = 'hydrate'; }, TypeError);
  await Promise.all([1, 5].map((delay) => runSSR(null, async () => {
    assert.equal(getRuntimeInfo().phase, 'server-render');
    assert.equal(runtime.phase, 'idle');
    await new Promise((resolve) => setTimeout(resolve, delay));
    assert.equal(getRuntimeInfo().phase, 'server-render');
  })));
  assert.equal(getRuntimeInfo().phase, 'idle');
  assert.throws(() => renderToStringSync(() => { throw new Error('测试异常'); }));
  assert.equal(getRuntimeInfo().phase, 'idle');
});

test('SSR 标记、hydration 状态、节点复用与多根卸载', async () => {
  const { html } = await renderToStringWithData(() => {
    assert.equal(getRuntimeInfo().phase, 'server-render');
    return document.createElement('button');
  }, { container: false });
  assert.match(html, /<!--plain-ssr:v1-->/);
  const dom = setup(html);
  const root = document.getElementById('app');
  const other = document.getElementById('other');
  assert.equal(getRootInfo(root).origin, 'ssr');
  assert.equal(getRootInfo(root).hydration, 'not-started');
  const button = root.querySelector('button');
  const result = hydrate(root, () => {
    assert.equal(getRuntimeInfo().phase, 'hydrate');
    assert.equal(getRootInfo(root).hydration, 'hydrating');
    return document.createElement('button');
  });
  assert.equal(root.querySelector('button'), button);
  assert.equal(getRootInfo(root).hydration, 'hydrated');
  assert.equal(getRootInfo(root).warnings, 0);
  const dispose = mount(other, () => {
    assert.equal(getRuntimeInfo().phase, 'client-render');
    return document.createElement('span');
  });
  assert.equal(getRootInfo(other).origin, 'csr');
  assert.equal(getRootInfo(root).origin, 'ssr');
  dispose();
  assert.equal(getRootInfo(other), undefined);
  result.dispose();
  assert.equal(getRootInfo(root), undefined);
  assert.equal(getRuntimeInfo().phase, 'idle');
  dom.window.close();
});

test('接管失败不会误报成功，缺少来源证据时保持 unknown', () => {
  const dom = setup('');
  const root = document.getElementById('app');
  assert.throws(() => hydrate(root, () => { throw new Error('接管失败'); }));
  assert.equal(getRootInfo(root).origin, 'unknown');
  assert.equal(getRootInfo(root).hydration, 'failed');
  assert.equal(getRuntimeInfo().phase, 'idle');
  dom.window.close();
});
