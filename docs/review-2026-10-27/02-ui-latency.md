# 02 · cc-statusline-mod UI 渲染路径延迟审查

- 对象：`C:\tjf\github\CCStatusLine\mod\hooks\register.mjs`（3.8.0，1795 行，commit `2405819`）
- 用户实况：出厂模板 22 按钮 / hideBelow=100 / contextWindow=200000（已从 `C:\Users\tjf\.claude\ccsl-buttons.json` 只读核实）；pricing.json 366 模型（已核实）；`$.store` 持久化文件已只读取证
- 方法：stub mods API 微基准（历史 stub 冒烟法的扩展，脚本与原始输出留档于 `C:\Users\tjf\AppData\Local\Temp\ccsl-review\scratch\`：bench.mjs / bench2.mjs / bench3.mjs / cold.mjs + bench-run1..3.txt / cold-runs.txt）+ git 提交核对 + 真实 store 取证
- 机器：Windows 11，Node v23.11.1，桌面开发机。所有数字为 **mod 侧 CPU**（stub 引擎成本为零），是端到端延迟的**下界**；引擎侧（树调和、终端绘制、跨 noun 调用真实延迟）从 stub 不可测，已在「未验证」注明。

---

## 摘要：Top 根因排名

| # | 根因 | 结论 | 置信度 |
| --- | --- | --- | --- |
| 1 | **mod 侧渲染路径在当前规模下全部是微秒级，不构成可感知延迟**（启动 ~6-9ms、每请求记录+重画 0.02-0.13ms、打开启动器 mod 侧 <0.1ms）。用户若感到"不丝滑"，瓶颈大概率在引擎侧（invalidate 后的全表面重画/树调和/终端绘制）或非本 mod | 见延迟预算表 | Confirmed（mod 侧数字实测）+ Speculative（引擎侧归因） |
| 2 | **每请求无条件 `$.ui.invalidate('ui.render')`，即使没有任何 ccsl 表面在显示动态数据**（band 本身无实时内容）。省掉的是引擎侧整轮重画，不是 mod 侧 | register.mjs:1284-1286 | Confirmed（代码）/ Likely（收益，引擎 diff 可能已把空重画做廉价） |
| 3 | **`usage-history` 自 3.7.0 起不再持久化**：README 仍宣称"跨会话滚动 240 条"（README.md:132，commit 2405819 专门写了这个语义），代码只写 `usage-cost-total`。用户真实 store 已取证：`usage-history` 冻结在 2026-10-25 18:55（3.6.1 时代），而 `usage-cost-total` 更新到 10-26 17:17 | register.mjs:1270 vs 3.6.1 `860b199:870`；store 文件 `cc-statusline-mod_skills-dir-*.json` | Confirmed（代码 + 提交 + 真实数据） |
| 4 | `resolvePricing` 每请求对 366 键做全表小写子串扫描（非精确命中路径）：~53-66µs/请求 | register.mjs:144-153 | Confirmed（实测）/ 量级无关紧要 |
| 5 | 线索假设"每请求全量序列化 240 条写 store"在 3.7.0 已被作者移除（3.0.0-3.6.1 确实如此，旧成本实测 256µs/请求） | git 核对 | Confirmed |

---

## 方法与证据

**stub 设计**：`on()` 分发器按事件/matcher 组链；`$` 各 noun 为计数 + 可调延迟（busy-wait，避开 Windows setTimeout ~10ms 粒度，第一轮曾被污染，已修正）；元素表 `Box/Text/Button` 为纯对象工厂并计数分配；`turn.step` 以 async generator 喂 K 个 chunk、result 带 usage 驱动。预热后取 mean/p50/p95。

**stub 局限**：① 每次跨 noun 调用 stub 只付 ~1µs 包装成本，真实引擎成本未知（用 0/0.05/0.5/2ms 四档做了敏感度外推）；② 无树调和/diff/终端绘制；③ 元素工厂无真实校验。数字应读作 mod 侧纯 CPU 下界。

**关键实测**（p50，n≥200；完整数据见 scratch/bench-run*.txt）：

| 路径 | p50 | 说明 |
| --- | --- | --- |
| import 模块（冷，含 15KB LEGACY_TEMPLATES 字符串） | 3.4-4.4ms | 一次性 |
| `register()` | ~1.2ms | 一次性 |
| session.start（暖，9 次跨 noun 调用） | 1.73ms | 2×fs.read(0.56ms 各) + JSON.parse pricing(0.61ms) 占大头 |
| session.start（0.5ms/noun 引擎延迟） | 6.6ms | 敏感度外推 |
| turn.step 记录（K=1 chunk，模型精确命中） | 19.7µs | 每请求固定成本下界 |
| turn.step 记录（模型走子串匹配，如 `glm-5.3[1m]`） | 78-103µs | 含 resolvePricing 全扫 |
| turn.step 记录（未知模型全扫 miss） | 110µs | |
| 每 chunk 透传（yield* 委托） | ≈1µs（含 harness 开销） | 500-chunk 流 p50 538µs，摊在整条流上 |
| 3.6.1 时代的每请求 `JSON.stringify(240条)` | 233µs | 已被 3.7.0 移除，现仅写数字(0.5µs) |
| band 绘制（启动器关） | 8µs，4 节点，2 跨 noun（resolve+panes） | |
| band 绘制（width<hideBelow 隐藏） | 2.7µs | 仍先付 resolve+panes 两个调用 |
| band 绘制（内联启动器展开） | 42µs，66 节点 | |
| 启动器 Pane 绘制（22 按钮 5 卡片） | 51µs，72 树节点，1 跨 noun | sectionEls 全量重建 |
| usage Pane 绘制（240 条历史） | 18µs | totals 8.4µs + spark(60) 4.9µs |
| toggle 按下同步段（open/close 派发） | 25.8µs / 25.5µs | **open/close 确在同步段内调用**（sync-zone 验证：仅 `ui.open`） |
| slash/prompt 按钮按下（关面板+fill+toast） | ~2-3µs mod 侧 | fill 真实成本在引擎 |
| run 按钮派发（stub 进程） | 14.6µs | spawn 在引擎 |
| /ccsl 命令（panes+launcherRows+open） | 11-30µs | |
| 复合：每请求 turn.step + band + 启动器 Pane 重画 | 107µs | mod 侧全链 |

---

## 发现清单

**U-1（Confirmed 代码 / Likely 收益）每请求无条件 invalidate，无表面打开时是白付的重画**
- 位置：`mod/hooks/register.mjs:1284-1286`（turn.step 尾部 `await $.ui.invalidate('ui.render')`）。
- 触发：每个模型请求（主会话+每个子代理）完成各一次；`ui.render` 失效会使引擎重答 band 与所有 Pane 钩子（重绘复用旧答案，需 invalidate——README/TODO 引官方 d.ts）。
- 后果：mod 侧重答一次 band 仅 ~8µs、启动器 Pane ~51µs，可忽略；但引擎侧每请求做整轮 diff/布局/绘制。长会话多子代理时是每请求的固定引擎开销（量级未测，Speculative 影响感知）。
- 修复草案：记录路径末尾改为条件失效——`paneUp || inlineUp || usagePaneOpen`（usage pane 可在记录时用一次 `$.ui.panes()` 探测，或跟踪 `/ccsl-usage` 打开）才 invalidate；band 无实时内容（仅 toggle 与 isWorking 标记，后者由引擎自己的重画刷新 props）。冷启动器关闭的普通会话即零引擎重画。注意保留 ctx 阈值 toast 路径不受影响。
- 频率：每请求一次。

**U-2（Confirmed）usage-history 停止持久化，README 宣称的语义已不存在**
- 位置：写入点在 3.7.0（`debc0ec`）被删（对比 3.6.1 `860b199:870` `await $.store.set('usage-history', history.slice(-MAX_POINTS))`）；现存唯一写入是 `register.mjs:1270` 的 `usage-cost-total`。读取点仍在：`register.mjs:1190`（session.start）与 `:1736`（usage 面板自愈）。
- 真实数据取证：`C:\Users\tjf\.claude\plugins\store\cc-statusline-mod_skills-dir-d15abeae7c73.json` —— `usage-history` 227 条，最后时间戳 2026-10-25T18:55:29Z（3.6.1 最后一次运行）；文件 mtime 2026-10-26T17:17（此后仅 cost-total 更新至 $10.9073）。即用户当前每个新会话恢复的是 10-25 的陈旧窗口，新记录只活在内存。
- 后果：usage 面板的 sparkline/"最近N次请求"跨会话不再滚动；README.md:132（commit `2405819` 刚写的"rolling last-240 across sessions, last writer wins"）与实现矛盾；`:1736` 的自愈路径永远读到陈旧数据。
- 修复草案（兼顾本审查初衷——不要把每请求 256µs 的全量写原样搬回）：节流持久化，记录时比较 `Date.now() - lastPersist`，≥30s 或达到 MAX_POINTS 边界才 `store.set('usage-history', history.slice(-MAX_POINTS))`；成本从每请求 256µs 降到每 30s 一次。
- 备注：这不是延迟缺陷，但它是线索假设核查的直接产物，且是当前用户真实数据里的活缺陷。

**U-3（Confirmed 实测 / 量级无关）resolvePricing 非精确命中路径全表扫描**
- 位置：`register.mjs:144-153`。`Object.keys(table)` + 逐键 `key.toLowerCase()` + `includes`，366 键 ≈53-66µs（replica 实测 p50 53µs / mean 66µs）。
- 触发：每个带 usage 的请求，模型名非表内精确键时（第三方网关的 `glm-5.3[1m]` 等必走此路）。
- 后果：每请求 ~0.06ms——占请求生命周期（秒级）可忽略；仅在极端 QPS 下有意义。
- 修复草案：加载 pricing 时构建一次 `lowerKey → rates` 索引（Map，按 key 长度降序遍历），把扫描降到 ~µs 级或二分。优先级低。

**U-4（Confirmed 代码 / 合理）band 每次绘制都付 resolve + panes 两个跨 noun 调用，隐藏时也付**
- 位置：`register.mjs:1568`（resolve）、`:1571`（panes）；hideBelow 判断在其后（`:1577-1585`）。
- 触发：引擎每次重画 band（含每请求 invalidate 引发的、resize、props 变化）。
- 后果：mod 侧 ~10µs 无所谓；引擎侧 `panes()` 若有真实成本则随绘制频率放大。顺序上先 re-sync 再判宽是**必要的**（注释言明：要在窄屏下真正看到并关掉已开面板），不建议改。
- 修复草案：无必改项。若 U-1 落地，band 重画频率本身会下降。

**U-5（Confirmed 实测）启动器树全量重建：每次绘制 72 节点 / ~65 次元素工厂调用，p50 51µs**
- 位置：`sectionEls` `register.mjs:1365-1443`；`sectionModel` `:1120-1133`（每次绘制对 5 分区 × 22 按钮做 filter，~110 次 sectionKey 调用 + 若干数组分配）；`displayUrl/displayRun` `:1145-1154` 每按钮每绘一次（µs 级）；`clip` `:183-185` 仅配置加载路径，不在渲染路径。
- 后果：mod 侧无感知影响；真实成本在引擎调和 72 节点的树（未测）。声明式 UI 每帧重建元素树是常态做法（React/Ink 同款），不值得做 memo——除非引擎实测调和大。
- 修复草案：不修。若将来按钮数上百，再考虑按 `buttons` 引用相等缓存 sectionModel 结果（配置重载才失效）。

**U-6（Confirmed 代码）run 按钮无取消，600s 内同命令防重入锁死**
- 位置：`register.mjs:1491-1513`（`runningCmd` 守卫 + `timeoutMs: 600000`）。
- 触发：命令挂起（如交互式命令、网络阻塞）。
- 后果：同 argv 按钮最长 10 分钟提示"已在运行中"，期间无法重跑；进程由引擎托管，mod 侧零占用。`lastRun.tail` 的 `(stdout+stderr).trim().slice(-160)`（`:1500`）在超大输出时有一次全量拼接分配——一次性、引擎已把字符串给到，非问题。
- 修复草案：提供取消（引擎 API 若无 kill 则降低 timeoutMs 或按按钮类型配 `timeoutMs`）；属 UX 项非延迟项。

**U-7（已验证无问题）无定时器、无空闲重画、无自定义输入处理**
- `setInterval/setTimeout` 全文 grep 为零。refreshInterval 属宿主 statusline 子进程（`~/.claude/settings.json` 的 statusLine 配置），与 mod 进程内渲染无关。mod 无键盘/Tab 处理代码——热键是 `Button.hotkey` 入站属性，命中即引擎调 `onPress`（TODO.md 引 d.ts：字母键需 site 持键盘）。
- 模块顶层 15KB `LEGACY_TEMPLATES`（`:252-1022`）只是字符串字面量，计入一次性 import 3.4-4.4ms，无渲染期成本。

**U-8（Confirmed 代码）session.start 串行 await 链共 9 次跨 noun 调用，mod 侧 ~1.7-4ms**
- 位置：`register.mjs:1188-1242`。store.get×2 → env.get×2 → fs.read(pricing) → env.get×2 → fs.read(buttons) → command.register×3，全串行；大头是 2 次文件读 + pricing JSON.parse（各 ~0.6ms）。
- 敏感度：若引擎每次 noun 调用真实延迟 0.5ms → 总 6.6ms；2ms → 20.3ms。均远低于感知阈值。
- 修复草案：不必修。真要省可并行 store 两个 get 与 command 注册，收益 ≤1ms。

---

## 对线索假设的逐条回应

| 线索假设 | 结论 | 证据 |
| --- | --- | --- |
| "每个 turn.step 都 history.push、`store.set('usage-history',240条)`、invalidate" | **部分不成立（关键一半已过期）**。push 与 invalidate 属实（`:1265`、`:1284`）；全量 240 条写 store 在 3.0.0-3.6.1 属实、3.7.0 起**删除**，现仅写 `usage-cost-total` 数字（`:1270`）。旧写法实测 256µs/请求，现行 0.5µs | git `debc0ec` diff + replica 实测 + 用户 store mtime 取证 |
| "invalidate 全树重画，长会话/多子代理成为每请求固定开销" | **mod 侧成立但便宜**：每请求 1 次 invalidate（Confirmed）；mod 侧重答 band 8µs + 打开中的 Pane 51µs；复合实测 p50 107µs/请求。引擎侧重画成本未测（Likely 是真正的固定开销，量级不明）；无合并证据——mod 未做去抖，引擎是否合并 invalidate 未验证 | B3/B5/B9 实测 |
| "band 每次绘制先 await $.ui.panes()，一次跨 noun 调用" | 属实（`:1571`），另有 resolve（`:1568`）；每次绘制 2 次。必要（re-sync Esc 关闭等引擎侧状态），mod 侧 µs 级 | 代码 + per-draw 计数 |
| "launcher Pane 绘制走 sectionModel→sectionEls 全量重建" | 属实；72 节点 / p50 51µs（见 U-5） | B5 实测 |
| "LEGACY_TEMPLATES 15KB 在模块顶层"（隐含启动/渲染负担） | 不构成问题：仅字符串字面量，一次性 import 共 3.4-4.4ms | cold.mjs ×5 |
| "366 个定价模型的 pricing.json" | session.start 一次 JSON.parse 0.61ms；每请求 resolvePricing 子串路径 53-66µs（U-3） | B1b/B2f 实测 |

---

## 延迟预算表

（目标列以"操作丝滑"= 交互 <1 帧感知阈值 ~16ms、后台项不占交互帧为口径；mod 侧为实测，引擎侧未测标 ?）

| 操作 | 现状实测 | 目标 | 差距 | 责任代码 |
| --- | --- | --- | --- | --- |
| 启动 → band 首绘 | mod 侧 import+register+session.start ≈ 6-9ms（冷）；引擎首绘 ? | <100ms | mod 侧达标 | `:1188-1242`（无需改） |
| 按 `m` 打开启动器 | 按键→press 同步段 25.8µs（open 同步发出，已验证）+ Pane 绘制 51µs + 引擎 open/布局/绘制 ? | <50ms | mod 侧 ≈0.08ms，剩余在引擎 | `:1587-1629`、`:1447-1554` |
| 窄屏隐藏态切换（hideBelow） | 隐藏绘制 2.7µs + 关面板；恢复后正常绘制 | 即时 | 达标 | `:1577-1585` |
| 每请求记录+重画（面板关） | turn.step 20-120µs（模型是否精确命中 pricing 决定）+ invalidate→band 8µs mod 侧；引擎整轮重画 ? | 不占交互帧 | mod 侧达标；引擎侧每请求一轮全表面重答是唯一可疑点 | `:1248-1292`（U-1） |
| 每请求记录+重画（启动器开） | 复合 p50 107µs mod 侧 + 引擎 diff 72 节点 ? | 同上 | 同上 | 同上 |
| 按 run 按钮 | 派发 14.6µs + 引擎 spawn；完成时 1 次 invalidate + toast | 派发即时 | 达标；挂起命令 600s 无取消（U-6） | `:1488-1513` |
| slash/prompt 按钮 | 关面板+fill+toast mod 侧 ~3µs；fill/Enter 属引擎 | 即时 | 达标 | `:1462-1487` |
| "滚动 usage" | **无滚动路径**：pane 恒定高度（60 档 sparkline + 合计行），240 条只是数据滚动窗口，非 UI 滚动 | — | — | `:1727-1794` |
| 空闲 | 无定时器、无自发重画；仅引擎触发（isWorking 翻转等） | 0 | 达标 | U-7 |

---

## 可观测性方案（不越 mods API）

1. **press→首绘差值（可测端到端引擎延迟）**：toggle/按钮 press 时记 `performance.now()` 到模块变量；下一次匹配的 `ui.render` 钩子首行读差值。同理记录 invalidate 发出→下一次 band 绘制的差值，即可在真机上量化引擎的 open/布局/重画延迟——这是 mod 唯一能拿到引擎侧时序的口径。
2. **模块内计数器 + 调试行**：累计各表面绘制次数、turn.step 记录数、invalidate 次数、最近 50 次绘制的 p50/p95（环形数组，纯内存）。在 usage 面板加一行 dim 调试输出（配置 `perf:true` 或 `$.env.get('CCSL_PERF')` 开关）。零额外 store 写入。
3. **不要**在热路径写 store/文件；需要留档时可每 30s 聚合写一次 `store.set('ccsl-perf', {...})`（顺带可承载 U-2 的节流持久化框架）。
4. 引擎内部（树调和耗时、panes() 成本、多表面分发次数）mod 不可见；只能靠 1 的差值法间接推断。

---

## 修复顺序（收益/成本）

1. **U-2 恢复 usage-history 节流持久化**（每 30s 或边界才写）：恢复 README 承诺的语义，修真实数据缺陷；成本几行 + 每 30s 一次 256µs 写。
2. **U-1 条件 invalidate**（无 ccsl 表面打开则跳过）：砍掉每请求一轮引擎全表面重答（引擎侧收益未量化，但方向确定）；成本几行，需同时探测 `/ccsl-usage` 打开态（记录时一次 `panes()` 或维护跟踪变量）。
3. **U-3 pricing 小写索引**：每请求 -60µs；成本一次性建 Map。仅在追求极限时做。
4. **U-6 run 取消/超时配置**：UX 项。
5. U-4/U-5/U-8 不修（已验证无感知影响）。

## 被推翻的怀疑 / 已验证无问题

- "每请求全量序列化 240 条写 store"——3.8.0 不存在（3.7.0 已删，git 核对）；旧成本 256µs 实测留档。
- "LEGACY_TEMPLATES 顶层 15KB 是负担"——一次性字符串，import 总共 3.4-4.4ms。
- "spark/totals/sectionEls 是同步重活"——实测 5-65µs。
- "mod 有定时器/空闲重画"——无（grep 零命中；refreshInterval 属 statusline 子进程）。
- "mod 自定义输入处理/Tab 遍历"——无，全部依赖引擎（hotkey 属性）。
- "toggle 同步派发可能失效"——实测 open/close 确在 press 同步段内被调用（sync-zone 验证），p50 26µs。
- 已知清单"已修复"项抽查：A3 重载后 invalidate（`:1320` 有）、B1 flexWrap/rows（`:1399-1414`、`:1183` 有）、A6 run 防重（`:1491-1495` 有）——属实。

## 未验证 / 局限

1. 引擎侧全部成本不可测：跨 noun 调用真实延迟、`ui.render` 失效后的树调和与终端绘制、`$.ui.open` 的布局/摆放延迟、invalidate 是否合并去抖。mod 侧数字是下界；"用户感到不丝滑"若属实，最可能在引擎侧，需按可观测性方案 1 在真机测 press→首绘差值定位。
2. 多表面（terminal+desktop）时钩子跑几遍：未验证（引擎行为，无 d.ts 对照本轮）。
3. 引擎自发 band 重画的频率（是否每键入/每 props 变化）未验证；若高频，U-4 的 2 次跨 noun 调用会随频率放大，但 mod 侧仍 µs 级。
4. stub 元素工厂是纯分配器，真实 `resolve()` 若做校验/上下文绑定则每次绘制成本高于实测（计数仍为 1 次/绘制）。
5. 第一轮基准的 setTimeout 粒度污染已用 busy-wait 修正；数字取自第二轮起，单机单进程，量级可信、个位 µs 差异不必较真。
6. 子代理并发风暴（N 个子代理同时完成请求）未单独压测——按线性叠加估算（每完成 1 请求 ≈ 0.1ms mod 侧 + 1 次 invalidate）。
