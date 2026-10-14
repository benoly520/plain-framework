// Plain 错误目录 —— **全框架唯一的一套错误码**。
//
// 历史包袱：lint 规则曾用 `plain/no-props-snapshot` 这类字符串，编译器用
// `PLAIN_E1005` 这类码，两套并存 —— 机器要记两套规则，IDE / CI / AI 也得写两套匹配。
// 现在收敛到一套 `PLAIN_Exxxx`，**编号自带分类**：
//
//   E10xx  编译器内部（正常写代码不该撞上；撞上就是编译器 bug，需附最小复现提 issue）
//   E11xx  lint：可自动修（`plaindev check` 默认改掉）
//   E12xx  lint：需手工修（改法视上下文而定，不自动改）
//   E2xxx  构建期（vite 插件 / CLI 入口的契约闸门）
//
// 每一条在目录里只登记一次：码、短名、层级、说明。lint 规则从这张表反查短名，
// 于是「规则码」与「错误码」是同一个来源，不会再各写各的。
//
// 兼容：`plain/no-props-snapshot` 这类旧名**仍被抑制指令接受**（见 lint.ts），
// 但输出的判等问题码是 `PLAIN_Exxxx`。旧名不再出现在 CLI / 插件输出里。

/** 错误码字面量联合 —— 新增码必须同时进这里与 `ERROR_CATALOG` */
export type PlainErrorCode =
  | "PLAIN_E1001"
  | "PLAIN_E1002"
  | "PLAIN_E1003"
  | "PLAIN_E1004"
  | "PLAIN_E1005"
  | "PLAIN_E1006"
  | "PLAIN_E1007"
  | "PLAIN_E1008"
  | "PLAIN_E1009"
  | "PLAIN_E1010"
  | "PLAIN_E1011"
  | "PLAIN_E1101"
  | "PLAIN_E1102"
  | "PLAIN_E1103"
  | "PLAIN_E1104"
  | "PLAIN_E1105"
  | "PLAIN_E1106"
  | "PLAIN_E1107"
  | "PLAIN_E1108"
  | "PLAIN_E1109"
  | "PLAIN_E1110"
  | "PLAIN_E1111"
  | "PLAIN_E1112"
  | "PLAIN_E2001";

/** lint 规则短名（无前缀）：一种反模式一个短名，与 `plain/<短名>` 一一对应 */
export type LintRuleName =
  | "signal-assign"
  | "signal-not-called"
  | "react-habit"
  | "no-inner-html"
  | "no-props-destructure"
  | "no-signal-mutate"
  | "no-props-snapshot"
  | "no-resolve-event-prop"
  | "no-async-effect"
  | "no-effect-loop"
  | "no-computed-side-effect";

export interface ErrorEntry {
  code: PlainErrorCode;
  /** lint 规则短名；编译器 / 构建期错误没有短名 */
  rule?: LintRuleName;
  /** 是否可被 `plain-ignore-line` 抑制（只有 lint 规则可抑制） */
  suppressible: boolean;
  /** 一句话说明（AGENTS.md §4 的表格用同一份文案） */
  summary: string;
}

/**
 * 错误目录 —— 单一事实来源。
 * `PLAIN_E1101`–`PLAIN_E1112` 与 lint 规则的对应关系在此固定，改动需同步：
 *   AGENTS.md §3 反模式目录 / §4 错误码、README、CHANGELOG、以及 test/errors.test.mjs。
 */
export const ERROR_CATALOG: Record<PlainErrorCode, ErrorEntry> = {
  // --- E10xx 编译器内部 ---------------------------------------------------
  PLAIN_E1001: {
    code: "PLAIN_E1001",
    suppressible: false,
    summary: "JSX 写法编译器不认识",
  },
  PLAIN_E1002: {
    code: "PLAIN_E1002",
    suppressible: false,
    summary: "产物无法被 JS 解析（输入没先剥离 TS 类型）",
  },
  PLAIN_E1003: {
    code: "PLAIN_E1003",
    suppressible: false,
    summary: "产物里残留 JSX（编译器 bug）",
  },
  PLAIN_E1004: {
    code: "PLAIN_E1004",
    suppressible: false,
    summary: "遇到不支持的语法节点（编译器 bug）",
  },
  PLAIN_E1005: {
    code: "PLAIN_E1005",
    suppressible: false,
    summary: "列表的 key 与 index 参数同时使用（语义二选一）",
  },
  PLAIN_E1006: {
    code: "PLAIN_E1006",
    suppressible: false,
    summary: "`server()` 的函数体引用了外部变量（闭包不会跟到服务端）",
  },
  PLAIN_E1007: {
    code: "PLAIN_E1007",
    suppressible: false,
    summary: "`server()` 的参数 / 返回值无法 JSON 序列化",
  },
  PLAIN_E1008: {
    code: "PLAIN_E1008",
    suppressible: false,
    summary: "JSX 属性展开 `{...expr}`（只做了半套支持，会静默跑错）",
  },
  PLAIN_E1009: {
    code: "PLAIN_E1009",
    suppressible: false,
    summary: "`ref` 用在组件上（组件没有稳定根节点）",
  },
  PLAIN_E1010: {
    code: "PLAIN_E1010",
    suppressible: false,
    summary: "`ref` 的值不是函数（应为 `ref={(el) => …}`）",
  },
  PLAIN_E1011: {
    code: "PLAIN_E1011",
    suppressible: false,
    summary: "`ref` 回调不能是 `async`（清理与异步不兼容）",
  },

  // --- E11xx lint：可自动修 ----------------------------------------------
  PLAIN_E1101: {
    code: "PLAIN_E1101",
    rule: "signal-assign",
    suppressible: true,
    summary: "直接给 signal 变量赋值，要用 `.set()`",
  },
  PLAIN_E1102: {
    code: "PLAIN_E1102",
    rule: "signal-not-called",
    suppressible: true,
    summary: "JSX 里把 signal 当值用，漏了调用 `()`",
  },
  PLAIN_E1103: {
    code: "PLAIN_E1103",
    rule: "react-habit",
    suppressible: true,
    summary: "React 肌肉记忆（`useState` / `useEffect` / `useMemo` / `useCallback` / `useRef`）",
  },
  PLAIN_E1104: {
    code: "PLAIN_E1104",
    rule: "no-inner-html",
    suppressible: true,
    summary: "`innerHTML` / `outerHTML` —— 框架的安全红线",
  },
  PLAIN_E1105: {
    code: "PLAIN_E1105",
    rule: "no-props-destructure",
    suppressible: true,
    summary: "解构 props，响应性会静默丢失",
  },
  PLAIN_E1106: {
    code: "PLAIN_E1106",
    rule: "no-signal-mutate",
    suppressible: true,
    summary: "就地对 signal 持有的值做修改（`items().push(x)`）",
  },
  PLAIN_E1107: {
    code: "PLAIN_E1107",
    rule: "no-props-snapshot",
    suppressible: true,
    summary: "把 props getter 存进变量 / 忘了 `resolve`",
  },
  PLAIN_E1108: {
    code: "PLAIN_E1108",
    rule: "no-resolve-event-prop",
    suppressible: true,
    summary: "`resolve(props.onClick)` —— `on*` 事件 prop 不能 resolve",
  },
  PLAIN_E1109: {
    code: "PLAIN_E1109",
    rule: "no-async-effect",
    suppressible: true,
    summary: "`effect(async () => …)` —— `await` 之后依赖收集失效",
  },
  PLAIN_E1110: {
    code: "PLAIN_E1110",
    rule: "no-effect-loop",
    suppressible: true,
    summary: "`effect` 读了又写同一个 signal，必然自触发",
  },
  PLAIN_E1111: {
    code: "PLAIN_E1111",
    rule: "no-computed-side-effect",
    suppressible: true,
    summary: "`computed` 里写 signal —— 派生值必须是纯的",
  },
  PLAIN_E1112: {
    code: "PLAIN_E1112",
    rule: "no-props-snapshot",
    suppressible: true,
    summary: "把 props getter 存进变量（赋值形态 / JSX 形态）",
  },

  // --- E2xxx 构建期 ------------------------------------------------------
  PLAIN_E2001: {
    code: "PLAIN_E2001",
    suppressible: false,
    summary: "契约检查未通过（dev / build 的闸门）",
  },
};

/** 短名 -> 错误码（lint 规则用） */
export const LINT_RULE_CODES: Record<LintRuleName, PlainErrorCode> = Object.fromEntries(
  Object.values(ERROR_CATALOG)
    .filter((e) => e.rule)
    .map((e) => [e.rule as LintRuleName, e.code])
) as Record<LintRuleName, PlainErrorCode>;

/** 错误码 -> 短名（反向查表；编译器 / 构建期错误没有短名） */
export function ruleNameOf(code: PlainErrorCode): LintRuleName | undefined {
  return ERROR_CATALOG[code]?.rule;
}

/** 短名 -> 错误码；未知短名返回 undefined（抑制指令里允许写任意旧名，不报错） */
export function codeOfRule(rule: string): PlainErrorCode | undefined {
  return LINT_RULE_CODES[rule as LintRuleName];
}

/** 旧写法 `plain/<rule>` —— 仅用于抑制指令的向后兼容匹配，不用于输出 */
export function legacyCode(rule: LintRuleName): string {
  return `plain/${rule}`;
}

/**
 * 抑制指令的匹配器：`plain-ignore-line PLAIN_E1107` 与
 * `plain-ignore-line plain/no-props-snapshot` 两种写法都要认。
 * 只在 **lint** 语境使用；编译器 / 构建期错误不可抑制。
 */
export function isSuppressed(
  allow: Set<string>,
  code: PlainErrorCode
): boolean {
  if (allow.size === 0) return true; // 没写规则码 = 抑制该行全部 lint 规则
  if (allow.has(code)) return true;
  const rule = ruleNameOf(code);
  return rule ? allow.has(legacyCode(rule)) : false;
}

/** 从源码里扫到的字符串，收集成「抑制指令认得的规则码」：新旧都认 */
export function parseSuppressionCodes(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.match(/\bPLAIN_E\d{4}\b/g) || []) set.add(m);
  for (const m of text.match(/\bplain\/[a-z-]+\b/g) || []) set.add(m);
  for (const m of text.match(/\b[a-z]+(?:-[a-z]+)+\b/g) || []) {
    // 裸短名（signal-assign 之类）也认 —— 但只在它确实是已知规则时才代表规则，
    // 否则会把普通连字符词误当规则码。这里交给 isSuppressed 做最终判定。
    if (codeOfRule(m)) set.add(m);
  }
  return set;
}
