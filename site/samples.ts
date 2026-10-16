// 官网展示的代码：左边是源码，右边是**真实编译产物**。
//
// 产物不是手写的示意：由 `dist/compiler` 真跑一遍得到（脚本见文件末尾注释）。
// 这些内容与语言无关，所以不放进 i18n 字典。

/** 官网展示的示例标识 */
export type SampleId = 'counter' | 'list' | 'server';

/** 一段示例：模块名 + 「编译前 / 编译后」两份代码 */
export interface Sample {
  file: string;
  source: string;
  output: string;
}

export const COUNTER_SOURCE = `import { signal, computed } from 'plain';

const count = signal(0);
const double = computed(() => count() * 2);

export function Counter() {
  return (
    <button onClick={() => count.set(count() + 1)}>点了 {count()} 次，翻倍 {double()}</button>
  );
}`;

export const COUNTER_OUTPUT = `import { effect as __effect, stringify as __stringify, insert as __insert, each as __each, when as __when, rpc as __rpc, place as __place, createEl as __createEl, __ref } from "plain";
import { signal, computed } from 'plain';

const count = signal(0);
const double = computed(() => count() * 2);

export function Counter() {
  {
const __f1 = document.createDocumentFragment();
const __el2 = __createEl("button", __f1);
__el2.addEventListener("click", () => count.set(count() + 1));
__el2.appendChild(document.createTextNode("点了 "));
__insert(__el2, () => (count()));
__el2.appendChild(document.createTextNode(" 次，翻倍 "));
__insert(__el2, () => (double()));
__f1.appendChild(__el2);
return __f1;
}
}`;

export const LIST_SOURCE = `import { signal } from 'plain';

const todos = signal([{ id: 1, text: '读一遍响应式规则', done: true }]);

export function TodoList() {
  return (
    <ul>
      {todos().map((todo) => <li key={todo.id} class={todo.done ? 'done' : ''}>{todo.text}</li>)}
    </ul>
  );
}`;

export const LIST_OUTPUT = `import { effect as __effect, stringify as __stringify, insert as __insert, each as __each, when as __when, rpc as __rpc, place as __place, createEl as __createEl, __ref } from "plain";
import { signal } from 'plain';

const todos = signal([{ id: 1, text: '读一遍响应式规则', done: true }]);

export function TodoList() {
  {
const __f1 = document.createDocumentFragment();
const __el2 = __createEl("ul", __f1);
__each(__el2, () => (todos()), (todo) => {
const __f3 = document.createDocumentFragment();
const __el4 = __createEl("li", __f3);
__effect(() => { __el4.className = __stringify(todo.done ? 'done' : ''); });
__insert(__el4, () => (todo.text));
__f3.appendChild(__el4);
return __f3;
}, (todo) => ((todo.id)));
__f1.appendChild(__el2);
return __f1;
}
}`;

export const SERVER_SOURCE = `import { server, resource } from 'plain';

const stats = server(async () => {
  const secret = process.env.DB_URL;
  return { users: 1024, online: 37 };
});

export function Stats() {
  const s = resource(() => stats());
  return <p>在线 {s.data()?.online} 人</p>;
}`;

export const SERVER_OUTPUT = `import { effect as __effect, stringify as __stringify, insert as __insert, each as __each, when as __when, rpc as __rpc, place as __place, createEl as __createEl, __ref } from "plain";
import { server, resource } from 'plain';

const stats = ((...__args) => __rpc("stats", __args));

export function Stats() {
  const s = resource(() => stats(), undefined, "server.tsx:9#0");
  {
const __f1 = document.createDocumentFragment();
const __el2 = __createEl("p", __f1);
__el2.appendChild(document.createTextNode("在线 "));
__insert(__el2, () => (s.data()?.online));
__el2.appendChild(document.createTextNode(" 人"));
__f1.appendChild(__el2);
return __f1;
}
}`;

// 两侧的模块名相同：变的是「同一个模块编译前 / 编译后」，不是文件挪了位置。
export const SAMPLES: Record<SampleId, Sample> = {
  counter: {
    file: 'Counter.tsx',
    source: COUNTER_SOURCE,
    output: COUNTER_OUTPUT,
  },
  list: {
    file: 'TodoList.tsx',
    source: LIST_SOURCE,
    output: LIST_OUTPUT,
  },
  server: {
    file: 'Stats.tsx',
    source: SERVER_SOURCE,
    output: SERVER_OUTPUT,
  },
};

/** 快速开始里的命令 id（文案在 i18n 字典里，命令本身两语一致） */
export type GuideStepId = 'deps' | 'dev' | 'build' | 'serve';

export const GUIDE_STEPS: { id: GuideStepId; cmd: string }[] = [
  { id: 'deps', cmd: 'pnpm add -D vite && pnpm add plain' },
  { id: 'dev', cmd: 'npx plaindev dev' },
  { id: 'build', cmd: 'npx plaindev build' },
  { id: 'serve', cmd: 'npx plaindev serve dist' },
];

export const GUIDE_VITE_CONFIG = `import { defineConfig } from 'vite';
import plain from 'plain/vite';

export default defineConfig({
  plugins: [plain()],
});`;

export const GUIDE_TSCONFIG = `{
  "compilerOptions": {
    "jsx": "preserve",
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true
  }
}`;

/** `plaindev check` 的真实输出（格式取自 src/lint.ts 与 src/cli/index.ts） */
export const CLI_OUTPUT = `$ npx plaindev check src
src/Counter.tsx
  x src/Counter.tsx:8:3  [PLAIN_E1101] 不能直接给 signal 变量 "count" 赋值，要用 "count.set(...)"
  x src/Counter.tsx:14:10  [PLAIN_E1102] signal 要调用取值："{count()}"
  -> 已自动修复并写回 src/Counter.tsx

[plaindev] 共 2 处问题，已修复 1 个文件`;

// 上面 COUNTER_/LIST_/SERVER_ 的产物重新生成方式（改了示例源码时跑一次）：
//   node -e "import('./dist/compiler/index.js').then(...)"  —— 见仓库 PR 里的临时脚本，
//   或直接 `node dist/cli/index.js check site` 确认示例源码本身不触发契约规则。
