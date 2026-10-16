// eval/compare/eslint.react.config.mjs —— React 侧的「构建期闸门」
//
// 存在的理由（见 README「公平性规则」第 2 条）：
// Plain 侧候选要走「契约检查 → 编译」，写错会在构建期被 PLAIN_Exxxx 拦下；
// React 侧若只做 JSX 转换，就**没有等价闸门** —— 那样比出来的差距来自
// 「框架带不带闸门」，而不是来自「AI 写得更准」，结论会失真。
//
// 所以给 React 侧接上两套官方/主流 lint，让两边都是「写错 → 构建期拦下」。
// 开关记进 eval/RESULTS.md。
//
// 覆盖的对应关系（与 Plain 的反模式目录对齐）：
//   @eslint-react/immutability        ←→ PLAIN_E1106（就地改 state / signal 持有的值）
//   react-hooks/rules-of-hooks        ←→ PLAIN_E1103（React 习惯移植）
//   react-hooks/immutability          ←→ 同上（官方插件版本，类型感知更强）
//   react-hooks/set-state-in-effect   ←→ PLAIN_E1110（effect 里同步写状态）
//   @eslint-react/no-nested-component-definitions ←→ PLAIN_E1109 类（effect/组件卫生）
//   react-hooks/exhaustive-deps       ←→ （Plain 无 deps 数组，此项使 React 侧更难）
//
// 为什么同时装两个插件（如实记录，别把它当冗余）：
//   - 官方 `eslint-plugin-react-hooks` 的 `immutability` 是 React Compiler 规则，
//     在**未接 React Compiler** 时对 `items.push(x)` 这类 mutating method 会漏报
//     （只有直接属性赋值 `x.foo = v` 才拦得住）—— 已实测。
//   - `@eslint-react` 的 `immutability` 是独立实现，**不需要 React Compiler**，
//     在纯 JSX（无类型标注）下也能拦住 `items.push(x)` —— 已实测。
//   两者互补，共同构成与 PLAIN_E1106 对称的闸门。
import reactHooks from "eslint-plugin-react-hooks";
import eslintReact from "@eslint-react/eslint-plugin";
import tseslint from "typescript-eslint";

const compilerRules = reactHooks.configs["recommended-latest"]?.rules ?? {
  "react-hooks/rules-of-hooks": "error",
  "react-hooks/exhaustive-deps": "warn",
};

export default tseslint.config(
  {
    files: ["**/*.jsx", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        // 不强制 project —— 候选文件是孤立片段，没有 tsconfig。
        // 有类型信息时规则更强；没有时退化为语法级判定（@eslint-react 仍可用）。
      },
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Promise: "readonly",
        Math: "readonly",
        JSON: "readonly",
        Array: "readonly",
        Object: "readonly",
        String: "readonly",
        Number: "readonly",
        Boolean: "readonly",
        Error: "readonly",
        Date: "readonly",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      ...eslintReact.configs["x"].plugins,
    },
    rules: {
      ...compilerRules,
      // react-hooks/rules-of-hooks 必须是 error：它对应 Plain 的 E1103（React 习惯移植）
      "react-hooks/rules-of-hooks": "error",
      // exhaustive-deps 保持默认的 warn —— 升级为 error 会过度惩罚 React 侧
      "react-hooks/exhaustive-deps": "warn",
      // 与 PLAIN_E1106 对称的核心闸门：就地改 state 持有的值
      "@eslint-react/immutability": "error",
      // ---------------------------------------------------------------------
      // 刻意降级为 warn 的规则（闸门只拦「确定错的」，不拦「有争议的」）
      // ---------------------------------------------------------------------
      // set-state-in-effect：官方 recommended-latest 里是 error，但它会把
      // `useEffect(() => { setData(null); /* 重置加载态 */ })` 判为级联渲染风险 ——
      // 这是 React 生态的**性能建议**而非正确性错误，而且它**误伤了本仓的
      // React 参考实现**（cases/05-async-loading/react.jsx）。闸门若保留原样，
      // harness 自检（--reference 必须全过）就无法通过，对比也就失去基线。
      // 取舍：降为 warn，让「能跑对的 React 写法」不被误杀。
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // 候选文件里允许未使用的 import（片段式实现常见）
    files: ["**/*.jsx", "**/*.tsx"],
    rules: {
      "no-unused-vars": "off",
    },
  }
);
