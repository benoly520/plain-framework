// Plain 官网首页 —— 这一页本身就是 Plain 写的（自举）。
//
// 写法遵守框架的 5 条规则：signal 是唯一状态原语 / 组件写成 return (<jsx />) /
// 列表用 .map / 条件用三元或 && / 只有真要在服务端跑才用 server()。
// 页内展示的代码产物在 samples.ts（真实编译产物），文案在 i18n.ts（中英双语）。

import { signal, computed, effect, useContext, mount } from 'plain';
import { COPIES, I18nCtx, type Lang } from './i18n.js';
import {
  SAMPLES,
  GUIDE_STEPS,
  GUIDE_VITE_CONFIG,
  GUIDE_TSCONFIG,
  CLI_OUTPUT,
  type SampleId,
} from './samples.js';
import './style.css';

const REPO_URL = 'https://github.com/benoly520/plain-framework';
const README_URL = REPO_URL + '#readme';
const LANG_KEY = 'plain-site-lang';

/** 首屏数字：都能在仓库里复算（体积见 `pnpm run benchmark`） */
const STAT_KEYS: { k: keyof typeof COPIES.zh.hero.stats; v: string }[] = [
  { k: 'vdom', v: '0' },
  { k: 'state', v: '1' },
  { k: 'gzip', v: '1.7 KB' },
  { k: 'deps', v: '2' },
];

/** 编译产物分页的顺序（文案在字典里） */
const TAB_IDS: SampleId[] = ['counter', 'list', 'server'];

/** 页脚文档入口 */
const DOC_LINKS: { k: string; label: string; href: string }[] = [
  { k: 'readme-en', label: 'README (EN)', href: REPO_URL + '#readme' },
  { k: 'readme-cn', label: 'README (中文)', href: REPO_URL + '/blob/main/README_CN.md' },
  { k: 'agents', label: 'AGENTS.md', href: REPO_URL + '/blob/main/AGENTS.md' },
  { k: 'patterns', label: 'docs/patterns.md', href: REPO_URL + '/blob/main/docs/patterns.md' },
  { k: 'spec', label: 'SPEC.md', href: REPO_URL + '/blob/main/SPEC.md' },
  { k: 'roadmap', label: 'ROADMAP.md', href: REPO_URL + '/blob/main/ROADMAP.md' },
  { k: 'eval', label: 'eval/', href: REPO_URL + '/tree/main/eval' },
  { k: 'changelog', label: 'CHANGELOG.md', href: REPO_URL + '/blob/main/CHANGELOG.md' },
];

// ---------------------------------------------------------------------------
// 语言：跨层取值走 Context（见 i18n.ts），这里只维护「当前语言」这一个 signal
// ---------------------------------------------------------------------------

/**
 * 读取语言偏好：无痕模式或被禁用时 localStorage 会直接抛错，所以必须兜住。
 * 没有存过则跟随浏览器语言。
 */
function readLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch (e) {
    console.warn('[site] 读取语言偏好失败，回退到浏览器语言', e);
  }
  return navigator.language && navigator.language.indexOf('en') === 0 ? 'en' : 'zh';
}

/** 记住语言偏好（存不进去也不算错误，只是下次回到默认） */
function persistLang(next: Lang) {
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch (e) {
    console.warn('[site] 保存语言偏好失败', e);
  }
}

const lang = signal<Lang>(readLang());

/** 切换语言（按钮在顶栏） */
function toggleLang() {
  const next: Lang = lang() === 'zh' ? 'en' : 'zh';
  persistLang(next);
  lang.set(next);
}

// ---------------------------------------------------------------------------
// 复制到剪贴板：按钮只记「刚复制了哪一条」，1.6 秒后自动回落
// ---------------------------------------------------------------------------

const copiedId = signal('');

/**
 * 把文本写进剪贴板。
 * clipboard API 在非安全上下文 / 老浏览器上可能不存在，写入也可能被拒绝，
 * 所以两条路径都要记录日志，而不是静默失败。
 */
function copyText(id: string, text: string) {
  const mark = () => {
    copiedId.set(id);
    setTimeout(() => {
      if (copiedId.peek() === id) copiedId.set('');
    }, 1600);
  };
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      console.warn('[site] 当前环境没有 clipboard API（需要 HTTPS 或 localhost）');
      return;
    }
    navigator.clipboard.writeText(text).then(mark, (err) => {
      console.error('[site] 写入剪贴板失败', err);
    });
  } catch (e) {
    console.error('[site] 复制失败', e);
  }
}

/** 复制按钮：文案随「刚复制的是不是自己」变化 */
function CopyBtn(props: { id: string; text: string }) {
  const c = useContext(I18nCtx);
  return (
    <button class="btn ghost sm" onClick={() => copyText(props.id, props.text)}>
      {copiedId() === props.id ? c().guide.copied : c().guide.copy}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 顶栏 / 首屏
// ---------------------------------------------------------------------------

function Header() {
  const c = useContext(I18nCtx);
  return (
    <header class="header">
      <div class="wrap header-inner">
        <a class="brand" href="#top">
          <span class="brand-mark">P</span>
          <span class="brand-name">Plain</span>
        </a>
        <nav class="nav">
          <a class="nav-link" href="#live">{c().nav.live}</a>
          <a class="nav-link" href="#compare">{c().nav.compare}</a>
          <a class="nav-link" href="#compile">{c().nav.compile}</a>
          <a class="nav-link" href="#gate">{c().nav.gate}</a>
          <a class="nav-link" href="#ai">{c().nav.ai}</a>
          <a class="nav-link" href="#guide">{c().nav.guide}</a>
          <a class="nav-link" href="#bounds">{c().nav.bounds}</a>
        </nav>
        <div class="header-actions">
          <button class="btn ghost sm" onClick={toggleLang}>{c().switchTo}</button>
          <a class="btn sm" href={REPO_URL} target="_blank" rel="noreferrer">{c().nav.github}</a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  const c = useContext(I18nCtx);
  return (
    <section class="hero" id="top">
      <div class="wrap hero-inner">
        <p class="badge">{c().hero.badge}</p>
        <h1 class="hero-title">
          {c().hero.title}
          <br />
          <span class="grad">{c().hero.titleAccent}</span>
        </h1>
        <p class="hero-desc">{c().hero.desc}</p>
        <div class="cta-row">
          <a class="btn lg" href="#guide">{c().hero.ctaStart}</a>
          <a class="btn ghost lg" href={README_URL} target="_blank" rel="noreferrer">
            {c().hero.ctaDocs}
          </a>
        </div>
        <p class="hero-note">{c().hero.note}</p>
        <div class="stats">
          {STAT_KEYS.map((s) => (
            <div class="stat" key={s.k}>
              <span class="stat-v">{s.v}</span>
              <span class="stat-k">{c().hero.stats[s.k]}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 跑一跑：两个真组件直接编译进这一页
// ---------------------------------------------------------------------------

function LiveCounter() {
  const c = useContext(I18nCtx);
  const count = signal(0);
  const double = computed(() => count() * 2);
  const reset = () => {
    count.set(0);
  };
  return (
    <div class="card">
      <div class="card-head">{c().demo.counterLabel}</div>
      <div class="row">
        <button class="btn" onClick={() => count.set(count() + 1)}>{c().demo.counterAdd}</button>
        <button class="btn ghost" onClick={reset}>{c().demo.counterReset}</button>
      </div>
      <div class="readout">
        <span class="readout-cell">
          <code>count()</code>
          <b>{count()}</b>
        </span>
        <span class="readout-cell">
          <code>double()</code>
          <b>{double()}</b>
        </span>
      </div>
      <p class="card-note">{c().demo.counterNote}</p>
    </div>
  );
}

type TodoItem = { id: number; text: string; done: boolean };

function LiveList() {
  const c = useContext(I18nCtx);
  const items = signal<TodoItem[]>([
    { id: 1, text: c().demo.seed[0], done: true },
    { id: 2, text: c().demo.seed[1], done: false },
  ]);
  const draft = signal('');
  let nextId = 3;

  const add = (where: 'head' | 'tail') => {
    const text = draft().trim();
    if (!text) return;
    const next: TodoItem = { id: nextId++, text, done: false };
    items.set(where === 'head' ? [next].concat(items()) : items().concat(next));
    draft.set('');
  };
  const toggle = (id: number) => {
    items.set(items().map((it) => (it.id === id ? { ...it, done: !it.done } : it)));
  };
  const remove = (id: number) => {
    items.set(items().filter((it) => it.id !== id));
  };

  return (
    <div class="card">
      <div class="card-head">{c().demo.listLabel}</div>
      <div class="row">
        <input
          class="input"
          placeholder={c().demo.listPlaceholder}
          value={draft()}
          onInput={(e) => draft.set(e.target.value)}
          onKeyDown={(e) => (e.key === 'Enter' ? add('tail') : undefined)}
        />
      </div>
      <div class="row">
        <button class="btn" onClick={() => add('head')}>{c().demo.listPrepend}</button>
        <button class="btn ghost" onClick={() => add('tail')}>{c().demo.listAdd}</button>
      </div>
      <ul class="todo">
        {items().map((item) => (
          <li class="todo-row" key={item.id}>
            <input type="checkbox" checked={item.done} onChange={() => toggle(item.id)} />
            <span class={item.done ? 'todo-text done' : 'todo-text'}>{item.text}</span>
            <button class="x" title={c().demo.listRemove} onClick={() => remove(item.id)}>×</button>
          </li>
        ))}
      </ul>
      {items().length === 0 ? <p class="card-note">{c().demo.listEmpty}</p> : null}
      <p class="card-note">{c().demo.listNote}</p>
    </div>
  );
}

function LiveSection() {
  const c = useContext(I18nCtx);
  return (
    <section class="section" id="live">
      <div class="wrap">
        <h2 class="section-title">{c().demo.title}</h2>
        <p class="section-desc">{c().demo.desc}</p>
        <div class="grid-2">
          <LiveCounter />
          <LiveList />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 对比 / 规则
// ---------------------------------------------------------------------------

function CompareSection() {
  const c = useContext(I18nCtx);
  return (
    <section class="section" id="compare">
      <div class="wrap">
        <h2 class="section-title">{c().compare.title}</h2>
        <p class="section-desc">{c().compare.desc}</p>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>{c().compare.dim}</th>
                <th>{c().compare.old}</th>
                <th class="th-plain">{c().compare.plain}</th>
              </tr>
            </thead>
            <tbody>
              {c().compare.rows.map((row) => (
                <tr key={row.k}>
                  <td class="td-dim">{row.dim}</td>
                  <td class="td-old">{row.old}</td>
                  <td class="td-plain">{row.plain}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function RulesSection() {
  const c = useContext(I18nCtx);
  return (
    <section class="section" id="rules">
      <div class="wrap">
        <h2 class="section-title">{c().rules.title}</h2>
        <p class="section-desc">{c().rules.desc}</p>
        <ol class="rules">
          {c().rules.items.map((item) => (
            <li class="rule" key={item.k}>
              <h3 class="rule-title">{item.title}</h3>
              <p class="rule-desc">{item.desc}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 源码 → 编译产物
// ---------------------------------------------------------------------------

function CompileSection() {
  const c = useContext(I18nCtx);
  const tab = signal<SampleId>('counter');
  const sample = () => SAMPLES[tab()];
  return (
    <section class="section" id="compile">
      <div class="wrap">
        <h2 class="section-title">{c().compile.title}</h2>
        <p class="section-desc">{c().compile.desc}</p>
        <div class="tabs">
          {TAB_IDS.map((id) => (
            <button
              class={tab() === id ? 'tab on' : 'tab'}
              key={id}
              onClick={() => tab.set(id)}
            >
              {c().compile.tabs[id]}
            </button>
          ))}
        </div>
        <div class="code-pair">
          <div class="code-pane">
            <div class="code-head">
              <span>{c().compile.from}</span>
              <code>{sample().file}</code>
            </div>
            <pre class="code"><code>{sample().source}</code></pre>
          </div>
          <div class="code-pane">
            <div class="code-head">
              <span>{c().compile.to}</span>
              <code>{sample().file}</code>
            </div>
            <pre class="code"><code>{sample().output}</code></pre>
          </div>
        </div>
        <p class="card-note">{c().compile.notes[tab()]}</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 编译期拦截 / 面向 AI
// ---------------------------------------------------------------------------

function GateSection() {
  const c = useContext(I18nCtx);
  return (
    <section class="section" id="gate">
      <div class="wrap">
        <h2 class="section-title">{c().gate.title}</h2>
        <p class="section-desc">{c().gate.desc}</p>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>{c().gate.code}</th>
                <th>{c().gate.meaning}</th>
              </tr>
            </thead>
            <tbody>
              {c().gate.rows.map((row) => (
                <tr key={row.k}>
                  <td class="td-code">{row.code}</td>
                  <td>{row.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="code-pane spaced">
          <div class="code-head">
            <span>{c().gate.cliTitle}</span>
            <CopyBtn id="cli" text={CLI_OUTPUT} />
          </div>
          <pre class="code"><code>{CLI_OUTPUT}</code></pre>
        </div>
      </div>
    </section>
  );
}

function AiSection() {
  const c = useContext(I18nCtx);
  return (
    <section class="section" id="ai">
      <div class="wrap">
        <h2 class="section-title">{c().ai.title}</h2>
        <p class="section-desc">{c().ai.desc}</p>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>{c().ai.fail}</th>
                <th class="th-plain">{c().ai.fix}</th>
              </tr>
            </thead>
            <tbody>
              {c().ai.rows.map((row) => (
                <tr key={row.k}>
                  <td class="td-old">{row.fail}</td>
                  <td class="td-plain">{row.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 快速开始 / 边界
// ---------------------------------------------------------------------------

function GuideSection() {
  const c = useContext(I18nCtx);
  return (
    <section class="section" id="guide">
      <div class="wrap">
        <h2 class="section-title">{c().guide.title}</h2>
        <p class="section-desc">{c().guide.desc}</p>
        <div class="steps">
          {GUIDE_STEPS.map((step) => (
            <div class="cmd-row" key={step.id}>
              <span class="cmd-label">{c().guide.cmds[step.id]}</span>
              <code class="cmd">$ {step.cmd}</code>
              <CopyBtn id={step.id} text={step.cmd} />
            </div>
          ))}
        </div>
        <p class="warn-note">{c().guide.npmNote}</p>
        <div class="code-pair">
          <div class="code-pane">
            <div class="code-head">
              <span>{c().guide.viteLabel}</span>
              <CopyBtn id="vite" text={GUIDE_VITE_CONFIG} />
            </div>
            <pre class="code"><code>{GUIDE_VITE_CONFIG}</code></pre>
          </div>
          <div class="code-pane">
            <div class="code-head">
              <span>{c().guide.tsLabel}</span>
              <CopyBtn id="tsconfig" text={GUIDE_TSCONFIG} />
            </div>
            <pre class="code"><code>{GUIDE_TSCONFIG}</code></pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function BoundsSection() {
  const c = useContext(I18nCtx);
  return (
    <section class="section" id="bounds">
      <div class="wrap">
        <h2 class="section-title">{c().bounds.title}</h2>
        <p class="section-desc">{c().bounds.desc}</p>
        <div class="grid-2">
          <div class="card">
            <div class="card-head">{c().bounds.todoTitle}</div>
            <ul class="plain-list">
              {c().bounds.todos.map((text) => <li key={text}>{text}</li>)}
            </ul>
          </div>
          <div class="card">
            <div class="card-head">{c().bounds.nongoalTitle}</div>
            <ul class="plain-list">
              {c().bounds.nongoals.map((text) => <li key={text}>{text}</li>)}
            </ul>
            <div class="card-head spaced">{c().bounds.tradeoffTitle}</div>
            <ul class="plain-list">
              {c().bounds.tradeoffs.map((text) => <li key={text}>{text}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const c = useContext(I18nCtx);
  return (
    <footer class="footer">
      <div class="wrap">
        <div class="footer-grid">
          <div>
            <div class="brand">
              <span class="brand-mark">P</span>
              <span class="brand-name">Plain</span>
            </div>
            <p class="footer-note">{c().footer.builtWith}</p>
          </div>
          <div>
            <div class="footer-title">{c().footer.docs}</div>
            <ul class="footer-links">
              {DOC_LINKS.map((link) => (
                <li key={link.k}>
                  <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div class="footer-title">{c().footer.repo}</div>
            <ul class="footer-links">
              <li>
                <a href={REPO_URL} target="_blank" rel="noreferrer">benoly520/plain-framework</a>
              </li>
              <li>
                <a href={REPO_URL + '/issues'} target="_blank" rel="noreferrer">Issues</a>
              </li>
              <li>
                <a href="#top">↑</a>
              </li>
            </ul>
          </div>
        </div>
        <p class="footer-bottom">{c().footer.license}</p>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// 根组件
// ---------------------------------------------------------------------------

function App() {
  // 语言变化时同步 <html lang> 与标题（读与写都不是 signal，没有自触发问题）
  effect(() => {
    const isEn = lang() === 'en';
    document.documentElement.lang = isEn ? 'en' : 'zh-CN';
    document.title = isEn
      ? 'Plain — a frontend framework that compiles to the DOM'
      : 'Plain —— 编译到 DOM 的前端框架';
  });
  return (
    <I18nCtx.Provider value={COPIES[lang()]}>
      <Header />
      <main>
        <Hero />
        <LiveSection />
        <CompareSection />
        <RulesSection />
        <CompileSection />
        <GateSection />
        <AiSection />
        <GuideSection />
        <BoundsSection />
      </main>
      <Footer />
    </I18nCtx.Provider>
  );
}

mount('#app', App());
