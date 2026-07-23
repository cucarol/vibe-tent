# X6 Working-set Canvas · 技术 Spike

**Claim:** `cx-y2tdtp` · **Task:** `tk-3hf4gca4`  
**范围:** 隔离验证 React + [@antv/x6](https://x6.antv.antgroup.com/) 是否适合 Tent Working-set Canvas。  
**非目标:** 不修改 `src/desktop` 正式 renderer、根 `package.json`/build、旧 HTML 原型。

本目录是**独立 Vite 实验**；依赖仅装在 `experiments/x6-working-set/node_modules`。

---

## 结论（给 UI 二宝验收）

| 问题 | 结论 |
| --- | --- |
| entityRef / placementId 分离？ | **可行且应保留。** 本 spike 强制 `placementId = pl-…`、`entityRef = cx-…`，拖动只写 placement。 |
| CanvasDocument 只含 viewport / placements / 视觉 group·annotation？ | **可行。** 见 `src/model/types.ts`；domain 树与 body 不进 document。 |
| ~250–300 真实感节点 + 四类 edge？ | **可渲染。** seed=7 → **291** nodes / **398** edges（parent 283 · resolved 79 · unresolved 34 · visual-annotation 2）。 |
| pan / zoom / drag / 框选 / 多选 / resize / group / viewport restore？ | **X6 插件链可覆盖。** Selection + Transform + panning + mousewheel；自定义 visual group 与 Restore VP。 |
| 拖动不改父子？ | **模型层有保证 + 运行时 invariant。** domain `parentEntityRef` 不在 drag 路径上；UI 显示 `parent drag safe`。 |
| Outline drawer / Focus Workspace / layout-only undo？ | **可做。** 见 UI 区实现；domain/lifecycle 只记 intent，不进 undo 栈。 |
| **是否推荐 X6 进入正式 Working-set Canvas？** | **有条件推荐（conditional yes）。** 适合作为 working-set 交互内核做下一阶段隔离壳；**不建议**直接绑进当前 `src/desktop/renderer`。见下方「限制」。 |

---

## 模型边界（与 Core / Service 对齐）

已读：

- `AGENTS.md`（主/Sub 分工）
- `src/core/types.ts`、`src/service/types.ts`（Concept / BoxProjection 等）
- claim `cx-kns7zx` Canvas 后端投影契约：graph projection **不含 placement**；placement 属视图态

### CanvasDocument（仅视图）

```ts
{
  version: 1,
  viewport: { x, y, zoom },
  placements: [{ placementId, entityRef, x, y, width, height, visualGroupId? }],
  visualGroups: [...],   // 纯视觉
  annotations: [...]     // 纯视觉
}
```

### 明确不是 Core 正式 schema

实验 edge 四类（overlay only）：

1. `parent` — 来自 domain 父子，**只读渲染**
2. `resolved-link` — 模拟已解析 Markdown/wiki link
3. `unresolved-link` — 悬空 target + ghost marker
4. `visual-annotation` — placement ↔ 画布批注

常量说明见 `EDGE_KIND_NOTE`（`src/model/types.ts`）。

---

## 如何运行

```bash
cd experiments/x6-working-set
npm install
npm run dev          # http://localhost:5179
npm test             # vitest · 6 tests
npm run build
npm run bench        # 无头合成图规模
```

浏览器内：**Metrics** 按钮可看 DOM / heap / 首帧；**Outline** 呼出抽屉；节点 **双击** 打开 Focus；**Shift+拖空白** 框选；**Undo/Redo** 仅 layout。

可选 Chromium 探针（需本机已装 Playwright browser）：

```bash
npm run build && npm run preview -- --host 127.0.0.1 --port 4179
# 另开终端
node scripts/browser-metrics.mjs http://127.0.0.1:4179/
```

---

## 测量证据

机器：Windows · Node 25 · Chromium via Playwright · 1440×900 · `seed=7`。

### A. 无头合成（`npm run bench`）

见 `evidence/bench.json`：

| 指标 | 值 |
| --- | --- |
| domainNodes | 291 |
| placements | 291 |
| edges | 398（p/r/u/v = 283/79/34/2） |
| CanvasDocument JSON | ~28.7 KB |
| domain projection JSON | ~84 KB |
| 合成 build | ~1.7 ms |

### B. 浏览器首屏 / 规模（`scripts/browser-metrics.mjs`）

见 `evidence/browser-metrics.json` 与 `evidence/spike-overview.png`：

| 指标 | 值 | 解读 |
| --- | --- | --- |
| nav → networkidle | ~588 ms | 含静态资源 + 首次图构建 |
| status `firstRender` | **~241 ms** | 页面内 `createWorkingSetGraph` 同步构建 |
| FCP | ~458 ms | 浏览器 paint |
| X6 node 元素 | 329 | 291 entity + groups + annotations + unresolved ghosts |
| X6 edge 元素 | 353 | 含未解析/视觉边；部分 domain 边若缺端点会跳过 |
| DOM under `.canvas-host` | **~4702** | 中等规模；未做虚拟化 |
| `performance.memory` heap | ~10 MB | Chromium 暴露值；**仅供参考**（易低估/受 GC 影响） |
| pan 手势墙钟 | ~256 ms | 含 8 步 mouse move，非单帧 cost |
| Outline 打开 | ~113 ms | drawer 挂载 |

### C. 交互体感（人工 + 探针）

- **Pan / Ctrl+wheel zoom：** 流畅；X6 默认实现足够 working-set 导航。
- **Drag placement：** 291 节点时拖动可接受；全量 edge 重路由在密集区偶发轻微粘滞（未量化逐帧）。
- **Rubberband 多选 + resize：** 插件可用；resize 走 layout undo。
- **Group：** 用户分组为**视觉** rect + `visualGroupId`，不改 domain parent。
- **Focus 关闭：** 恢复进入 Focus 前的 viewport + selection；draft 按 `entityRef` 单份保留。

### D. 自动测试

```text
npm test → 6 passed
- CanvasDocument 键集合
- entityRef ≠ placementId · 250–300 规模
- 四类 edge
- updatePlacement 不改 parentEntityRef
- layout undo/redo
- Focus 单 draft / expand-collapse
```

---

## 限制与风险

1. **包体积：** production chunk ~**687 KB** JS（gzip ~202 KB），主要是 X6。正式接入需 code-split / 按需插件。
2. **无节点虚拟化：** 4700+ DOM under canvas；扩展到 1k+ 节点需裁剪/LOD/聚合，X6 默认不解决。
3. **React 集成是命令式桥：** Graph 挂在 `useEffect`，layout history 与 X6 cell 双向同步需自律；易出现「双源」bug，正式层要收紧单一写路径。
4. **未解析 link：** spike 用 ghost node 示意，正式 UI 应更克制（badge / 列表），避免污染 graph。
5. **History 插件未用 X6 内置 History：** 本 spike 自研 layout stack，避免 domain 操作进栈；正式产品应统一命令总线。
6. **未接 Local Service：** 合成数据模拟 graph projection；真实 backlinks / box.projection 批量契约由 `cx-kns7zx` 交付，本 spike 不替代。
7. **诊断视觉克制：** 灰底点阵 + 低饱和 type 色；非正式皮肤。

---

## 推荐路径（非产品拍板，仅工程建议）

**推荐 X6 作为 Working-set Canvas 的候选内核，进入「隔离 React 壳」下一阶段，前提：**

1. 继续 **entityRef ≠ placementId**，CanvasDocument 永不进 Core。
2. 正式 renderer 仍走独立壳（对齐 `cx-gmcryd`），**不**改当前三栏 `src/desktop/renderer` 主路径直到壳验收。
3. 先接只读 graph + box projection；placement 本地/prefs 持久化。
4. 评估 1k 节点前必须做视口裁剪或分层。
5. 若包体/虚拟化成为硬约束，再对比轻量自研（现有 `canvas-kit.js`）或其它引擎——但 **X6 已证明能承载本 spike 验收清单**。

**不推荐：** 因本 spike 成功而直接把 X6 打进根依赖或现有 Electron renderer 打包管线。

---

## 目录

```text
experiments/x6-working-set/
  src/model/          CanvasDocument · synthetic graph · types
  src/canvas/         X6 graph factory / bridge
  src/state/          layout undo · focus drafts · intent log
  src/ui/             Outline · Focus · Intent rail
  src/metrics/        perf helpers
  test/               vitest
  scripts/            bench · browser-metrics
  evidence/           测量产物
  package.json        仅实验依赖
```

---

## 验收对照

| 要求 | 状态 |
| --- | --- |
| entityRef / placementId 分离 | ✅ |
| CanvasDocument 仅 viewport/placements/visual | ✅ |
| 250–300 节点 | ✅ 291 |
| 四类 edge 且非 Core schema | ✅ |
| pan/zoom/drag/框选/多选/resize/group/viewport restore | ✅ |
| 拖动只改 placement | ✅ 测试 + invariant |
| Outline drawer 可呼出并定位 | ✅ |
| Focus 窄/宽 + 关闭恢复 + 单 draft | ✅ |
| layout-only undo/redo；domain/lifecycle intent 展示 | ✅ |
| 测量 + README 证据与推荐 | ✅ |
| 最小自动测试 | ✅ 6 |
| 不碰正式 renderer / 根 package / 旧原型 | ✅ |
| Git commit | ✅（任务交付提交） |
