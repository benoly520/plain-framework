// errors.ts 单测：统一错误码目录是「单一事实来源」——码不重复、lint 码与规则一一对应、
// 旧名 `plain/<rule>` 仍被抑制指令接受。
//
// 目的：这次是把 lint 的 `plain/*` 与编译器的 `PLAIN_E*` 两套收敛成一套。
// 收敛最容易出的错是「表里写了码、lint 却用了另一个」「别名漏了一个」——
// 用测试把目录与 lint 实际产出钉死，避免又漂回去。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_CATALOG,
  LINT_RULE_CODES,
  ruleNameOf,
  codeOfRule,
  legacyCode,
  parseSuppressionCodes,
  isSuppressed,
} from "../dist/errors.js";
import { check } from "../dist/lint.js";

test("错误码唯一性：每个 code 只登记一次，编号前缀落在已知区间", () => {
  const codes = Object.keys(ERROR_CATALOG);
  assert.equal(new Set(codes).size, codes.length, "code 不可重复");
  for (const c of codes) {
    assert.match(c, /^PLAIN_E\d{4}$/, `${c} 形如 PLAIN_Exxxx`);
    const band = c.slice(7, 9); // 去掉 "PLAIN_E"，取前两位
    assert.ok(["10", "11", "20"].includes(band), `${c} 落在 10 / 11 / 20 区`);
  }
});

test("lint 规则码与短名一对一：表是 lint 与文档的共同来源", () => {
  const rules = Object.keys(LINT_RULE_CODES);
  const codesForRules = Object.values(LINT_RULE_CODES);
  assert.equal(new Set(codesForRules).size, rules.length, "一个短名对一个码");
  for (const [rule, code] of Object.entries(LINT_RULE_CODES)) {
    assert.equal(ERROR_CATALOG[code].rule, rule, `${code} 的短名应是 ${rule}`);
    assert.equal(ruleNameOf(code), rule, "反查短名一致");
    assert.ok(ERROR_CATALOG[code].suppressible, "lint 码应可抑制");
    assert.equal(legacyCode(rule), `plain/${rule}`, "兼容旧名形状");
  }
});

test("编译器 / 构建期码不可抑制，且没有短名", () => {
  for (const c of ["PLAIN_E1001", "PLAIN_E1002", "PLAIN_E1003", "PLAIN_E1004", "PLAIN_E2001"]) {
    assert.equal(ERROR_CATALOG[c].suppressible, false, `${c} 不可抑制`);
    assert.equal(ERROR_CATALOG[c].rule, undefined, `${c} 不应有规则短名`);
  }
});

test("lint 实际产出的码都在目录里（写错码会被这条抓到）", () => {
  const cases = [
    "import { signal } from 'plain';\nconst c = signal(0);\nc = 1;",
    "import { signal } from 'plain';\nconst c = signal(0);\nexport function A(){ return <p>{c}</p>; }",
    "import { useState } from 'react';\nexport function A(){ return <p/>; }",
    "const el = document.createElement('div');\nel.innerHTML = '<b>x</b>';",
    "export function A(props){ const { t } = props; return <p>{t}</p>; }",
    "import { signal } from 'plain';\nconst a = signal([]);\na().push(1);",
    "export function A(props){ const t = props.title; return <p>{t}</p>; }",
    "import { signal, effect } from 'plain';\nconst c = signal(0);\neffect(() => c.set(c() + 1));",
    "import { signal, computed } from 'plain';\nconst c = signal(0);\nconst d = computed(() => { c.set(1); return c(); });",
  ];
  const produced = new Set();
  for (const src of cases) for (const i of check(src, "x.tsx")) produced.add(i.code);
  assert.ok(produced.size > 0, "至少应产出一些码");
  for (const c of produced) {
    assert.ok(ERROR_CATALOG[c], `lint 产出了目录里没有的码：${c}`);
    assert.ok(ERROR_CATALOG[c].rule, `${c} 应带规则短名`);
  }
});

test("抑制指令的新旧两种写法都认：PLAIN_E1101 与 plain/signal-assign", () => {
  const src = (code) =>
    [
      "import { signal } from 'plain';",
      "const count = signal(0);",
      `// plain-ignore-next-line ${code}`,
      "count = count() + 1;",
    ].join("\n");
  assert.deepEqual(check(src("PLAIN_E1101"), "a.tsx"), [], "新码可抑制");
  assert.deepEqual(check(src("plain/signal-assign"), "a.tsx"), [], "旧名仍可抑制");
  assert.deepEqual(
    check(src("PLAIN_E1108"), "a.tsx").map((i) => i.code),
    ["PLAIN_E1101"],
    "码不匹配照报"
  );
});

test("parseSuppressionCodes：抓新码 / 旧名 / 裸短名", () => {
  const s = parseSuppressionCodes("PLAIN_E1107 plain/no-effect-loop signal-assign 无关词");
  assert.ok(s.has("PLAIN_E1107"));
  assert.ok(s.has("plain/no-effect-loop"));
  assert.ok(s.has("signal-assign"), "裸短名（确实是已知规则）也认");
  assert.ok(!s.has("无关词"));
});

test("isSuppressed：空集表示全抑制；点名才匹配；旧名映射到新码", () => {
  assert.equal(isSuppressed(new Set(), "PLAIN_E1101"), true);
  assert.equal(isSuppressed(new Set(["PLAIN_E1101"]), "PLAIN_E1101"), true);
  assert.equal(
    isSuppressed(new Set(["plain/signal-assign"]), "PLAIN_E1101"),
    true,
    "旧名应经短名映射命中"
  );
  assert.equal(isSuppressed(new Set(["PLAIN_E1108"]), "PLAIN_E1101"), false);
  // 无短名的码（编译器 / 构建期）：不经旧名匹配，只认精确码
  assert.equal(
    isSuppressed(new Set(["plain/whatever"]), "PLAIN_E1001"),
    false,
    "编译器码没有短名，旧名匹配必须落空"
  );
  assert.equal(isSuppressed(new Set(["PLAIN_E1001"]), "PLAIN_E1001"), true);
});

test("codeOfRule：已知短名有码，未知短名返回 undefined", () => {
  assert.equal(codeOfRule("no-props-snapshot"), "PLAIN_E1112");
  assert.equal(codeOfRule("other-rule"), undefined);
});
