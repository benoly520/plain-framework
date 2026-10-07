// 真实浏览器端到端验证：生产构建 + 生产服务器 + Chromium
// 用法：node test/browser.mjs
// 产出截图到 examples/todo/shots/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "examples/todo/dist");
const MANIFEST = path.join(ROOT, "examples/todo/.plain/server.mjs");
const SHOTS = path.join(ROOT, "examples/todo/shots");
const PORT = 8421;

const { serve } = await import(pathToFileURL(path.join(ROOT, "dist/server/index.js")).href);

let passed = 0;
let failed = 0;
const fails = [];

function ok(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL ${msg}`);
    failed++;
    fails.push(msg);
  }
}

fs.mkdirSync(SHOTS, { recursive: true });
const server = await serve({ dist: DIST, manifest: MANIFEST, port: PORT });
const base = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

console.log("\nPlain 浏览器端到端验证\n" + "=".repeat(52));

await page.goto(base, { waitUntil: "networkidle" });
await page.waitForTimeout(200);

// 1. 首屏
let lis = page.locator("ul.todos li");
ok((await lis.count()) === 4, `首屏渲染 4 条待办（实际 ${await lis.count()}）`);
ok(
  (await page.locator("ul.todos li.done").count()) === 2,
  "其中 2 条为已完成状态"
);
await page.screenshot({ path: path.join(SHOTS, "1-home.png"), fullPage: true });

// 2. 勾选 -> 行 UI 必须立刻更新（历史上致命 bug 的回归点）
const row3 = lis.nth(2);
ok(
  !(await row3.getAttribute("class")).includes("done"),
  "第 3 条初始未完成"
);
await row3.locator('input[type="checkbox"]').click();
await page.waitForTimeout(60);
lis = page.locator("ul.todos li");
ok(
  (await lis.nth(2).getAttribute("class")).includes("done"),
  "勾选后第 3 条 class 变为 done"
);
ok(
  await lis.nth(2).locator('input[type="checkbox"]').isChecked(),
  "勾选后 checkbox 为选中态"
);
ok(
  (await page.locator(".row.small .muted").textContent()).includes("剩 1 项"),
  "派生状态（剩余数）同步更新"
);

// 取消勾选
await lis.nth(2).locator('input[type="checkbox"]').click();
await page.waitForTimeout(60);
ok(
  !(await page.locator("ul.todos li").nth(2).getAttribute("class")).includes(
    "done"
  ),
  "再次点击后回到未完成（历史上第二次操作会整列表消失）"
);

// 3. 新增
await page.locator("input.input").first().fill("浏览器里新增的一条");
await page.locator("button.btn").first().click();
await page.waitForTimeout(80);
ok(
  (await page.locator("ul.todos li").count()) === 5,
  `新增后有 5 条（实际 ${await page.locator("ul.todos li").count()}）`
);
ok(
  (await page.locator("input.input").first().inputValue()) === "",
  "提交后输入框被清空"
);
await page.screenshot({ path: path.join(SHOTS, "2-added.png"), fullPage: true });

// 4. 筛选
await page.getByRole("button", { name: "已完成" }).click();
await page.waitForTimeout(80);
ok(
  (await page.locator("ul.todos li").count()) === 2,
  `筛选「已完成」剩 2 条（实际 ${await page.locator("ul.todos li").count()}）`
);
await page.getByRole("button", { name: "全部" }).click();
await page.waitForTimeout(80);
ok((await page.locator("ul.todos li").count()) === 5, "切回「全部」恢复 5 条");

// 5. 删除
await page.locator("ul.todos li").last().locator("a.del").click();
await page.waitForTimeout(80);
ok((await page.locator("ul.todos li").count()) === 4, "删除后回到 4 条");

// 6. ErrorBoundary：触发 -> 降级 -> 关闭开关 -> 重试 -> 恢复
await page.getByRole("button", { name: "人为触发错误" }).click();
await page.waitForTimeout(100);
ok(
  (await page.locator(".error-box").count()) === 1,
  "ErrorBoundary 把子树错误降级成兜底 UI（而不是整页白屏）"
);
ok(
  (await page.locator("ul.todos li").count()) === 4,
  "错误边界之外的部分不受影响"
);
await page.screenshot({ path: path.join(SHOTS, "5-error.png"), fullPage: true });
await page.getByRole("button", { name: "关掉错误开关" }).click();
await page.waitForTimeout(80);
await page.getByRole("button", { name: "重试" }).click();
await page.waitForTimeout(120);
ok(
  (await page.locator(".error-box").count()) === 0,
  "retry 后子树恢复正常渲染"
);

// 7. 路由跳详情详情
await page.locator("ul.todos li").first().locator("a.detail").click();
await page.waitForTimeout(120);
ok(page.url().includes("#/todo/1"), `URL 变为详情页（${page.url()}）`);
ok(
  (await page.locator(".card-title").textContent()).includes("待办 #1"),
  "详情页标题正确"
);
await page.screenshot({ path: path.join(SHOTS, "3-detail.png"), fullPage: true });

// 7. 路由到统计页 + 真实 RPC
await page.getByRole("link", { name: "统计" }).click();
await page.waitForTimeout(400);
ok(
  (await page.locator(".stat").count()) === 3,
  `统计页渲染 3 张卡片（实际 ${await page.locator(".stat").count()}）`
);
const values = await page.locator(".stat-value").allTextContents();
ok(values[0] === "1024" && values[1] === "37", `RPC 返回真实数据 ${values.join("/")}`);
await page.screenshot({ path: path.join(SHOTS, "4-stats.png"), fullPage: true });

// 8. 带参数的 server 调用
await page.locator("input.input").first().fill("测试");
await page.waitForTimeout(400);
ok(
  (await page.locator("p.warn").textContent()).includes("敏感词"),
  "敏感词校验：服务端判定并返回"
);
await page.locator("input.input").first().fill("新词");
await page.waitForTimeout(400);
ok(
  (await page.locator("p.ok").last().textContent()).includes("可以用"),
  "换个词重新调用服务端并更新"
);
await page.screenshot({ path: path.join(SHOTS, "6-audit.png"), fullPage: true });

// 9. 404
await page.goto(base + "#/nope/xxx", { waitUntil: "networkidle" });
await page.waitForTimeout(150);
ok((await page.locator(".card-title").textContent()) === "404", "未匹配路由落到 404");

// 10. 控制台无报错
ok(errors.length === 0, `控制台无错误（实际 ${errors.length}：${errors.slice(0, 3).join(" | ")}）`);

await browser.close();
await new Promise((r) => server.close(r));

console.log("=".repeat(52));
console.log(`通过 ${passed} / ${passed + failed}`);
if (failed) {
  console.log("失败：\n  - " + fails.join("\n  - "));
  process.exit(1);
}
console.log("浏览器端全部通过，截图见 examples/todo/shots\n");
