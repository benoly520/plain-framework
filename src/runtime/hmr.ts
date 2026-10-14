// Plain HMR 运行时：热替换「重跑组件 + 替换它产出的 DOM 子树」，不整页刷新
//
// 设计要点（对应 ROADMAP M4 验收标准）：
//   1. 挂载点注册表：记下每个组件的模块 id、容器、以及「回收 / 重建」两个回调；
//   2. 热替换：dispose 旧 effect（回收）→ 重跑新组件 → 用注册时传入的 rebuild
//      整体替换子树（rebuild 内部复用 createSlot + syncRange 的最小重排，
//      从而保住焦点/滚动/输入内容）；
//   3. 模块作用域 signal 的值尽力保留：基于 import.meta.hot.data 快照，
//      仅在可安全迁移时保留；保留不了必须显式 console.warn，绝不静默重置。
//
// 本模块零依赖（不 import dom.ts / signal.ts），与 dom.ts 之间不构成循环。

/** 一次挂载的注册记录 */
export interface MountRecord {
  /** 模块标识（vite 传入的 module id / 路径） */
  id: string;
  /** 组件挂载到哪个容器 */
  container: Node;
  /** 当前组件引用（热替换时更新） */
  comp: () => any;
  /** 回收该子树全部 effect */
  dispose: () => void;
  /**
   * 用「当前 comp」重建子树。
   * 由调用方（dom.ts / hydrate.ts）注入，内部用 createSlot + syncRange 做最小重排。
   */
  rebuild: (comp: () => any) => void;
}

const registry = new Set<MountRecord>();
let nextId = 0;

/**
 * 「当前模块 id」——vite 插件在模块顶部注入 `__plainScope(id, () => {…})` 时设置。
 * mount()/hydrate() 若未显式传 moduleId，就取它，从而让挂载点与「所在模块」
 * 自动关联，hmrApply(模块 id) 才能精确命中。零配置即可用。
 */
let currentModuleId: string | null = null;

/** 在指定的模块 id 作用域内执行 fn（模块顶层代码通常在其中调用 mount） */
export function hmrScope(id: string, fn: () => void): void {
  const prev = currentModuleId;
  currentModuleId = id;
  try {
    fn();
  } finally {
    currentModuleId = prev;
  }
}

/** 读取当前模块 id（mount/hydrate 无显式 moduleId 时的默认值） */
export function getHmrModuleId(): string | null {
  return currentModuleId;
}

/**
 * 标记「接下来顶层代码属于模块 id」——vite 插件在模块顶部注入调用。
 * 与 hmrScope 的区别：本函数不做闭包包裹（模块体里的 export 无法放进函数），
 * 只设置一个「当前模块 id」，供随后的 mount()/hydrate() 读取。
 */
export function __plainBeginModule(id: string): void {
  currentModuleId = id;
}

/**
 * hmrRegister —— 登记一个挂载点，使其可被 hmrApply 定位与热替换。
 * 返回注销函数。
 */
export function hmrRegister(record: Omit<MountRecord, "id"> & { id?: string }): () => void {
  const id = record.id ?? currentModuleId ?? `__plain__${nextId++}`;
  const rec: MountRecord = { id, ...record } as MountRecord;
  registry.add(rec);
  return () => registry.delete(rec);
}

/**
 * hmrApply(id, newMod) —— 热替换入口（由 vite 插件注入的 import.meta.hot.accept 调用）。
 *
 * 两条路，都不是「什么都不做」：
 *
 * 1. **精确替换**：改动的模块自己就是挂载模块（`mount()` 写在它里面），且新版本导出了
 *    根组件（`App`，回退 `default`）—— 只替换它的子树，别的子树 / 焦点 / 滚动都不动。
 * 2. **重跑兜底**：改动的是**被别处使用**的模块（独立组件文件、`import()` 懒加载进来的模块）。
 *    vite 的 HMR 已经把新版本接进了导入方，所以把这些挂载点的**根组件重跑一遍**就能取到新代码。
 *    代价是这些子树会被重建（丢焦点 / 滚动），但**不会整页刷新**，模块作用域 signal 值也留着。
 *
 * 以前这里只有第 1 条，其余情况打一句 warning 就返回 false —— 结果是**静默保持旧代码**
 * （改了组件、界面纹丝不动，且没有任何提示）。这是最坏的失败模式。
 *
 * 返回「是否有挂载点被替换 / 重跑」。返回 false 时调用方应退化到整页刷新。
 */
export function hmrApply(id: string, newMod: any): boolean {
  if (!registry.size) return false; // 一个挂载点都没有：没什么可替换（也不是错误）

  const exact: MountRecord[] = [];
  for (const rec of registry) if (rec.id === id) exact.push(rec);
  const comp = pickComponent(newMod);

  if (exact.length) {
    if (!comp) {
      // 这个模块明明是挂载点，新版本里却找不到根组件 —— 无法用新代码重建，
      // 明说并交给整页刷新，绝不留在旧代码上。
      console.warn(
        `[plain hmr] 模块 ${id} 是挂载点，但新版本里没有根组件（导出 App 或 default）——` +
          `无法精确热替换，改为整页刷新`
      );
      return false;
    }
    for (const rec of exact) {
      rec.dispose(); // 回收旧 effect（等价 createScope 的泄漏断言方式）
      rec.comp = comp;
      rec.rebuild(comp);
    }
    return true;
  }

  // 重跑兜底：改动的模块被别的挂载点使用。哪些子树用到了它，运行时无法廉价地知道，
  // 所以按「全部重跑根组件」处理 —— 正确性优先于少重建几棵树。
  for (const rec of Array.from(registry)) {
    rec.dispose();
    rec.rebuild(rec.comp);
  }
  return true;
}

/** 从模块命名空间挑出根组件 */
function pickComponent(mod: any): (() => any) | null {
  if (!mod) return null;
  if (typeof mod.App === "function") return mod.App;
  if (typeof mod.default === "function") return mod.default;
  return null;
}

// ---------------------------------------------------------------------------
// 模块作用域 signal 的值保留
// ---------------------------------------------------------------------------

export interface SignalSnapshot {
  [exportName: string]: { value: any; ok: boolean };
}

/**
 * snapshotSignals(mod) —— 快照模块导出里的 signal 值。
 * signal 识别特征：函数、带 `peek`/`set`、且带 `subs`（见 signal.ts）。
 */
export function snapshotSignals(mod: any): SignalSnapshot {
  const snap: SignalSnapshot = {};
  if (!mod) return snap;
  for (const key of Object.keys(mod)) {
    const v = mod[key];
    if (isSignal(v)) snap[key] = { value: v.peek(), ok: isPreservable(v.peek()) };
  }
  return snap;
}

/**
 * restoreSignals(mod, snap, moduleId) —— 把快照值写回新模块的 signal。
 * 保留不了必须显式告警，绝不静默重置（ROADMAP M4 验收要求）。
 */
export function restoreSignals(mod: any, snap: SignalSnapshot, moduleId = "?"): void {
  if (!mod || !snap) return;
  for (const key of Object.keys(snap)) {
    const v = mod[key];
    if (!isSignal(v)) continue;
    const prev = snap[key];
    if (!prev.ok) {
      console.warn(
        `[plain hmr] 模块 ${moduleId} 的 signal "${key}" 值无法保留，已重置` +
          `（快照值类型不可安全迁移）`
      );
      continue;
    }
    v.set(prev.value);
  }
}

function isSignal(v: any): boolean {
  return (
    typeof v === "function" &&
    typeof v.peek === "function" &&
    typeof v.set === "function" &&
    v.subs instanceof Set
  );
}

/** 值是否可安全迁移：原始值 / null / undefined 可；对象/函数/DOM 节点记 ok=false（告警） */
function isPreservable(value: any): boolean {
  if (value === null || value === undefined) return true;
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" || t === "bigint";
}

/** 仅供测试：清空注册表 */
export function __clearHmrRegistry(): void {
  registry.clear();
  currentModuleId = null;
}

/** 仅供测试：查看当前注册的模块 id */
export function __hmrIds(): string[] {
  return Array.from(registry, (r) => r.id);
}
