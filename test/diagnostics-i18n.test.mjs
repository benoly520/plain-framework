import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { compile } from '../dist/compiler/index.js';
import { check, formatIssues, autofix } from '../dist/lint.js';
import plugin from '../dist/vite/index.js';
import { resolveLocale } from '../dist/diagnostics.js';

const source = 'import {signal} from "plain"; const report = signal(0); ' +
  'export function App(){ const current = report(); return <p>{current}</p>; }';

/** 捕获插件构建错误并返回结构化诊断。 */
async function contractError(locale) {
  try {
    await plugin({ locale }).transform(source, '/project/App.tsx');
    assert.fail('Expected a contract error');
  } catch (error) {
    assert.equal(error.code, 'PLAIN_E2001');
    return error;
  }
}

test('中英文契约诊断保留规则码、位置和动态表达式', async () => {
  const zh = await contractError('zh-CN');
  const en = await contractError('en');
  assert.match(zh.message, /契约检查未通过/);
  assert.match(en.message, /Contract checks failed/);
  assert.match(en.message, /PLAIN_E1202/);
  assert.match(en.message, /current/);
  assert.match(en.message, /report\(\)/);
  assert.match(en.message, /computed/);
  assert.doesNotMatch(en.message, /[\u3400-\u9fff]/);
  assert.equal(en.line, zh.line);
  assert.equal(en.column, zh.column);
});

test('本地化不影响 lint 自动修复', () => {
  const input = 'import {signal} from "plain"; const count = signal(0); count = 1;';
  const issues = check(input, 'App.tsx');
  const zh = formatIssues(issues, 'App.tsx', 'zh-CN');
  const en = formatIssues(issues, 'App.tsx', 'en');
  assert.match(zh, /不能直接/);
  assert.match(en, /count/);
  assert.doesNotMatch(en, /[\u3400-\u9fff]/);
  assert.match(autofix(input, issues), /count\.set\(1\)/);
});

test('语言选择不会改变成功编译的业务代码或体积', () => {
  const input = 'export function App(){ return <p>Hello</p>; }';
  const zh = compile(input, 'App.jsx', { locale: 'zh-CN' });
  const en = compile(input, 'App.jsx', { locale: 'en' });
  assert.deepEqual(en, zh);
  assert.equal(Buffer.byteLength(en.code), 389);
  assert.equal(createHash('sha256').update(en.code).digest('hex'),
    '1863b4a9ac022092e60e90c444b585bf023b79b158b3875be1c800f658af6e14');
  assert.doesNotMatch(en.code, /diagnostics|PLAIN_LOCALE|Contract checks/);
});

test('编译器实例语言相互隔离', () => {
  const input = 'import {server} from "plain"; const fn = () => 1; const run = server(fn);';
  for (const locale of ['en', 'zh-CN', 'en']) {
    assert.throws(() => compile(input, 'App.jsx', { locale }), (error) => {
      assert.equal(error.code, 'PLAIN_E1012');
      assert.equal(/[\u3400-\u9fff]/.test(error.message), locale === 'zh-CN');
      return true;
    });
  }
});

test('CLI locale 参数不被误认为目标目录', () => {
  for (const args of [['--locale', 'en'], ['--locale=en']]) {
    const result = spawnSync(process.execPath, ['dist/cli/index.js', 'help', ...args], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--locale/);
    assert.doesNotMatch(result.stdout, /[\u3400-\u9fff]/);
  }
});

test('显式语言配置支持中英文别名', () => {
  assert.equal(resolveLocale('zh-CN'), 'zh-CN');
  assert.equal(resolveLocale('en-US'), 'en');
});

test('语言环境优先级与 auto 回退', () => {
  const cases = [
    [{ PLAIN_LOCALE: 'en', LANG: 'zh_CN.UTF-8' }, undefined, 'en'],
    [{ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }, undefined, 'zh-CN'],
    [{ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }, undefined, 'zh-CN'],
    [{ LANG: 'zh_CN.UTF-8' }, 'auto', 'zh-CN'],
    [{ LANG: 'C.UTF-8' }, undefined, 'en'],
    [{ LANG: 'fr_FR.UTF-8' }, undefined, 'en'],
    [{ PLAIN_LOCALE: 'zh-CN' }, 'en', 'en'],
  ];
  for (const [env, value, expected] of cases) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import {resolveLocale} from "./dist/diagnostics.js"; ' +
      `console.log(resolveLocale(${JSON.stringify(value)}));`,
    ], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PLAIN_LOCALE: '', LC_ALL: '', LC_MESSAGES: '', LANG: '', ...env },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});

test('浏览器运行时打包不包含诊断目录', async () => {
  const result = await build({
    entryPoints: [new URL('../dist/runtime/index.js', import.meta.url).pathname],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  assert.ok(result.outputFiles[0].contents.length > 0);
  for (const input of Object.keys(result.metafile.inputs)) {
    assert.doesNotMatch(input, /diagnostics|compiler\/messages|cli\//);
  }
});
