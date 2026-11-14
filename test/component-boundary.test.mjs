import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { compile } from '../dist/compiler/index.js';
import * as runtime from '../dist/runtime/index.js';

const dom = new JSDOM('<!doctype html><body></body>');
for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event']) {
  globalThis[key] = dom.window[key];
}
const temp = mkdtempSync(join(tmpdir(), 'plain-component-'));
after(() => rmSync(temp, { recursive: true, force: true }));

async function fixture(source, name) {
  const result = compile(source, `${name}.jsx`);
  const url = new URL('../dist/runtime/index.js', import.meta.url).href;
  const file = join(temp, `${name}.mjs`);
  writeFileSync(file, result.code.replace(/from\s+["']plain["']/g, `from "${url}"`));
  return import(pathToFileURL(file).href);
}

test('component construction snapshots do not subscribe insert; bindings and owner cleanup survive', async () => {
  const mod = await fixture(`
    import { signal, insert, effect, onCleanup } from 'plain';
    export const text = signal('initial');
    export const visible = signal(true);
    export let builds = 0;
    export let disposed = 0;
    export let runs = 0;
    function Field(props) {
      builds++;
      const snapshot = props.value;
      onCleanup(() => disposed++);
      effect(() => { props.value; runs++; });
      return <input value={props.value} onInput={(e) => text.set(e.target.value)} />;
    }
    function Box(props) { return <div>{props.children()}</div>; }
    const NS = { Field };
    export function App() {
      return <Box>{visible() ? <NS.Field value={text()} /> : null}</Box>;
    }
  `, 'construction');
  const host = document.createElement('div');
  document.body.append(host);
  const scope = runtime.createScope(() => host.append(mod.App()));
  try {
    const input = host.querySelector('input');
    input.focus();
    for (const value of ['a', 'ab', 'abc']) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      assert.equal(host.querySelector('input'), input);
      assert.equal(document.activeElement, input);
    }
    assert.equal(mod.builds, 1);
    assert.equal(mod.runs, 4);
    mod.visible.set(false);
    assert.equal(host.querySelector('input'), null);
    assert.equal(mod.disposed, 1);
    mod.text.set('hidden');
    assert.equal(mod.runs, 4);
    mod.visible.set(true);
    assert.equal(host.querySelector('input').value, 'hidden');
    assert.equal(mod.builds, 2);
    mod.visible.set(false);
    assert.equal(mod.disposed, 2);
  } finally {
    scope.dispose();
    host.remove();
  }
  assert.equal(mod.disposed, 2);
});

test('construction errors restore the surrounding dependency tracking', () => {
  const value = runtime.signal(0);
  let runs = 0;
  const effect = runtime.effect(() => {
    runs++;
    assert.throws(() => runtime.__component(() => { throw new Error('build'); }));
    value();
  });
  value.set(1);
  assert.equal(runs, 2);
  effect.dispose();
  assert.equal('untracked' in runtime, false);
});
