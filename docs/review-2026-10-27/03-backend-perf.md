# 03 — 事件记录 / 宿主命令派发 / 持久化层审查（cc-statusline-mod v3.8.0）

审查对象：`C:\tjf\github\CCStatusLine\mod\hooks\register.mjs`（HEAD = 2405819，mod 版本 3.8.0，plugin.json 已核对）。
方法：通读代码 + git 归属核对 + 本机量化实验（`%TEMP%\ccsl-review\03-exp\`，3 个脚本，不联网）+ 用户真实数据只读测量（`~/.claude/plugins/store/`、`~/.claude/pricing.json`）+ 引擎二进制字符串考古（claude.exe 2.1.309）。
置信度：Confirmed（代码+实测双证）/ Likely（代码确证、依赖未证实的引擎行为）/ Speculative（推断，待证伪）。

---

## 摘要 — Top 风险排名

| # | 风险 | 归因版本 | 证据强度 |
|---|---|---|---|
| 1 | **B-1** `usage-history` 3.7.0 起只读不写，但两处 `store.get` 仍活着：本机 store 里冻结的 227 条 3.6.x 旧记录在每个会话开头被重复注入，污染 token 总计/sparkline/请求计数；README:132 仍宣称"跨会话滚动 240 窗口" | debc0ec (3.7.0) 移除写入 | Confirmed（git diff + 真实 store 数据） |
| 2 | **B-2** `runningCmd` 单槽防重：任一命令完成都会清掉别人的运行标记（`.finally(() => runningCmd = null)`），两条不同命令交叠时防重完全失效，可重复启动同一命令 | 47200f3 (3.8.0) 引入防重 | Confirmed（代码 + 确定性复现） |
| 3 | **B-3** store 写放大：`usage-cost-total` 是标量，但引擎按**整个命名空间单 JSON 文件**落盘——本机每次 cost 写入重写 26.7 KB（携带 227 条冻结旧记录），实测 OS 层 ~6.5 ms/写 | debc0ec (3.7.0) 语义变化 + 旧数据残留 | Confirmed（文件 mtime/内容/体积三重观察；引擎调度方式未验证） |
| 4 | **B-4** 并发会话 `usage-cost-total` last-writer-wins：两会话各自以同一基线累加、整体覆盖写，对方会话的全部成本增量丢失（"累计"偏低） | debc0ec (3.7.0) | Confirmed（代码语义；README 未对 cost 键声明此语义） |
| 5 | **B-5** run 按钮超时孤儿进程：`hostArgv()` 在 win32 把 npm 类包成 `cmd /c`，实测杀 cmd 后 node 孙进程存活；引擎超时是否树杀未证实 | 47200f3 (3.8.0) `cmd /c` 派发 | Likely（OS 层 Confirmed + 引擎层未验证） |
| 6 | **B-6** run 按钮输出全量进内存（`r.stdout + r.stderr` 拼接后仅展示尾 160 字符）；引擎侧缓冲上限未知 | 3.0.0 起即如此 | Likely（插件侧 Confirmed，引擎侧 Speculative） |

---

## 发现清单

### B-1（Confirmed）`usage-history` 写入被删、读取残留：冻结旧数据每会话重复注入 + README 与代码不符
- 位置：写入删除见 `mod/hooks/register.mjs` 现文件仅存 `store.get`：`:1190-1191`（session.start 恢复）、`:1736-1737`（usage pane 自愈读）；`store.set` 全仓库仅剩 `:1270`（`usage-cost-total`）。
- 归属：`git log -S` 确认 3.0.0（30514ff）引入 `store.set('usage-history', history.slice(-MAX_POINTS))`，**3.7.0（debc0ec）将其删除**并替换为 cost-total 标量写；两处 get 未删。
- 触发条件：曾运行过 ≤3.6.x 的安装路径（本机 `~/.claude/plugins/store/cc-statusline-mod_skills-dir-d15abeae7c73.json` 实测含 227 条 2026-10-25 的记录，字段 `ts,out,in,cacheR,cacheW`——3.6.x 形状，无 `cost/ctx`）。
- 后果（全部实机数据可证）：
  1. 每个会话 session.start 把 227 条两天前的记录载入 `history` → usage pane 的 `最近{N}次请求`、`out/in/cacheR/cacheW` 总计、sparkline（last 40/60）在会话前 ~227 个请求内被旧数据抬高；新记录逐条把旧记录挤出 240 窗口后恢复，但下一会话又从头来（store 永不更新）。
  2. `t.cost`（`$X 会话`）不受影响——旧记录无 `cost` 字段，贡献 0。
  3. README.md:132「rolling last 240 requests across sessions; two concurrent sessions share one history (last writer wins)」描述的是 3.6.x 行为，与当前代码相反；TODO.md:231（C2）同样过时。
  4. 自愈注释 `:1731-1738`（"the pane never lies … while the store holds some"）已名不副实。
- 修复草案（二选一，属语义决策）：
  - (a) 让文档服从代码：删除两处 `store.get('usage-history')`，改 README/TODO 措辞为"会话内窗口，跨会话仅累计成本持久化"。改动最小。
  - (b) 恢复跨会话窗口：`turn.step` 里节流写（见 S1）+ 键名升版（`usage-history-v2`，天然丢弃 3.6.x 冻结数据）。
- 附带：`:1191` 恢复时无 `MAX_POINTS` 截断（当前无害，(b) 方案需补 `slice(-MAX_POINTS)`）。

### B-2（Confirmed）`runningCmd` 单槽防重在命令交叠时失效，可重复拉起进程
- 位置：pane 派发 `:1491-1513`、inline 派发 `:1676-1697`（两份拷贝共享模块级 `runningCmd`，`:83`）。关键行：`.finally(() => { runningCmd = null; })`（`:1510-1512`、`:1695-1697`）不校验自己是否还持有槽位。
- 触发条件（两个已确定性复现的场景，见 exp3）：
  1. A（短命令）与 B（长命令）并发：A 完成时把 `runningCmd` 清空 → B 仍在跑，再按 B → 第二个 B 进程启动。
  2. B 占槽期间再按 A：`runningCmd === runKey(A)` 不成立 → 第二个 A 进程启动。
- 后果：同一命令双进程并发（如两次 `git pull --ff-only`、两个 build）；叠加 B-7 无并发上限，进程数无界。3.8.0 之前无防重（TODO A6 记录"连按两次会启动两个进程"），3.8.0 的修复在交叠场景下等于没修。
- 修复草案：`let runningCmds = new Set()`；启动前 `if (runningCmds.has(runKey)) {toast; return}`，启动时 `add`，`.finally(() => runningCmds.delete(runKey))`。两处派发各改 4 行。exp3 已验证该修法两个场景均正确拒绝。

### B-3（Confirmed）store 命名空间级写放大：每请求重写 26.7 KB 冻结数据
- 事实链（本机实测）：store 落地为**每插件安装路径一个 JSON 文件**（`~/.claude/plugins/store/cc-statusline-mod_skills-dir-d15abeae7c73.json`，26,729 B，含全部键）；文件 mtime=今天 01:06 而 `usage-history` 内容停在 10-25 18:55 → 今天有 cost 写入且整文件重写、旧键原样随写。
- 量化（本机，Defender 在环）：26.7 KB `writeFileSync` ~6.46 ms/次 vs 33 B 标量 ~0.97 ms/次；`JSON.stringify` 整命名空间 148.5 µs vs 标量 0.49 µs。每会话 ~240 个带 cost 请求 → ~6.4 MB 写流量、~1.6 s 累计 I/O（OS 层下限；引擎若异步/去抖则更低——调度方式未验证，见局限）。
- 触发条件：store 残留大数据（本机=227 条旧记录）+ 每请求一次 `store.set`（`:1267-1272`）。全新安装（空 store）写放大不成立（文件恒 ~40 B）——**这是 3.7.0 半截迁移（删了写、没清键）与本机遗留数据的合成效应**。
- 后果：I/O/CPU 均非致命，但与 3.7.0"只存标量"的意图直接矛盾；且 SSD 写放大无谓。
- 修复草案：B-1(a) 落地时顺手 `store.set('usage-history', [])` 一次性清掉冻结键（或引擎支持 delete 则删键）；再加 S1 节流。

### B-4（Confirmed）并发会话 cost-total 覆盖丢账（README 声明缺失）
- 位置：`:1192-1193`（启动读基线）、`:1268-1270`（内存累加 + 整体覆盖写）。
- 语义：两会话同装路径同时跑，各自 `costAll = 基线 + 本会话增量`，每次写整体覆盖 → 终值 = 最后写者的视图，**另一会话全部增量丢失**。无 read-modify-write。
- 与 README 对照：README:132 只对（已不写的）`usage-history` 声明了 last-writer-wins，对现在真正共享的 `usage-cost-total` 未置一词。按任务口径这是"事实观察"：键共享 + 单文件整体写 = 覆盖语义；是否算缺陷由 owner 定（S1 节流会把丢账窗口从"每请求"扩大到"每节流周期"，需要 README 一句话声明）。
- 附带观察：两个 store 文件按**安装路径哈希**分命名空间（`inline-d55e4af5a7d8` vs `skills-dir-d15abeae7c73`）——`--plugin-dir mod` 预览与正式安装的数据互不相通，升级/切换安装方式会"丢"累计（实机：inline 文件无 cost-total 键）。

### B-5（Likely）600s 超时 + `cmd /c` 包装 → 孙进程孤儿（引擎杀法未证实）
- 位置：`hostArgv()` `:1166-1171`（win32 npm/npx/yarn/pnpm/bun → `['cmd','/c',...]`）；`$.process.run(..., { timeoutMs: 600000 })` `:1498`、`:1683`。
- OS 层事实（exp2 实测）：Windows 上 `child.kill()` 杀掉 `cmd /c` 后，其 node 孙进程**继续运行**（心跳确认存活，无 job object/进程组语义）。
- 引擎层未证实：claude.exe（2.1.309）二进制内存在 `taskkill.exe /PID … /T` 与 `killTree` 字符串（说明引擎某处有树杀能力），但无法定位 `$.process.run` 超时路径用的是树杀还是裸 kill。若为裸 kill：每个超时的 npm 类 run 按钮都留下一个最长不死的孙进程（600s 超时形同虚设，按钮却已回闲置态可再次点击）。
- 修复草案：插件侧可自保——run 完成回调里校验 `r.exitCode` 是否为超时哨兵并在 toast 里提示"可能残留子进程"；根治需引擎树杀或 `$.process.spawn` 句柄。真机验证项：跑一个 `cmd /c node -e "setTimeout(()=>{},1e9)"` 按钮等 600s（或临时调小 timeoutMs）观察进程树。

### B-6（Likely）run 按钮输出无上限：全量进内存、插件侧 2× 瞬时峰值
- 位置：`:1500`、`:1685`：`const tail = ((r.stdout || '') + (r.stderr || '')).trim().slice(-160)`。
- 事实：`$.process.run` 返回完整 `stdout/stderr` 字符串；插件再拼接一份（瞬时 2×峰值），仅保留尾 160 字符展示。600s 内可产生的输出量即持有量（`npm run build` 重日志、误跑到 `git log` 全量等场景）。引擎内部是否设缓冲上限：未证实（二进制 `maxBuffer` 字符串命中均在 Bun/JSC 上下文，不能归给 process.run）。
- 修复草案（插件侧最小）：先各自 `slice(-160)` 再拼接，峰值降到 ~320 B；彻底方案依赖引擎（流式或 `maxOutputBytes` 选项），建议向上游提需求。另注：`browserArgv` 的 rundll32 派发（`:1459`、`:1652`）**没传 timeoutMs**——rundll32 正常即退，属理论悬挂点，补一个短超时即可。

### B-7（Confirmed）并发不同 run 按钮无进程数上限
- 位置：同 B-2 派发点；仅 `runningCmd` 一个槽，无计数器。不同 argv 各自放行，连点 N 个按钮 = N 个并发宿主命令（每个最长 600s）。修复：B-2 的 Set 顺手 `if (runningCmds.size >= 4) { toast '并发已满'; return }`。

### B-8（Confirmed 代码形态 / Speculative 后果）`/ccsl-buttons` 的 invalidate 是裸浮动调用
- 位置：`:1320` `$.ui.invalidate('ui.render');` 未包 `safe`、未 await/catch（turn.step 里的同调用 `:1284-1286` 是包了的）。若返回被拒的 promise → unhandled rejection，视引擎策略可能计入插件故障。同类的还有 `:1225`、`:1493`、`:1496` 等裸 `$.ui.toast(...)`。修复：统一 `safe()` 或 `.catch(() => {})`。

### B-9（Likely）热重载清空本会话 history（因从未持久化）
- 依据：`session.start` 注释"fires on load AND on every hot reload"；TODO.md D 节"重载时 buttons、toggle 回到 null"佐证模块态会重置。重载后 `history=[]` → 从 store 恢复 = 227 条冻结旧记录，**本会话已记录的请求/会话成本全部丢失**（`$X 会话` 归零，`$Y 累计` 幸存）。未实机验证热重载，置信 Likely。修复随 B-1 方案 走（恢复节流写则天然免疫）。

### B-10（Likely/观察）多 surface 下 module state 一致性
- `paneUp` 每次 band 绘制从 `$.ui.panes()` 重同步（`:1571-1572`），自愈；Esc 与下一次绘制之间有一帧陈旧窗口（toggle 误 close → 引擎报错被 catch + toast，无害）。`inlineUp` 引擎不可见，纯模块态：desktop+terminal 双 surface 并存时两个 band 共享它，行为一致但未实测。usage pane 返回按钮 `:1759` 打开启动器不设 `paneUp=true`，靠下次绘制自愈。全部为自愈型小瑕疵，不升级为缺陷。

---

## 量化实验结果（本机：Node 23.11.1，Win11，Defender 在环；脚本见 03-exp\）

| 测项 | 结果 |
|---|---|
| resolvePricing 精确命中 `table[model]` | 0.19 µs/次 |
| resolvePricing 子串命中（`glm-5.3[1m]`→`glm-5.3`，366 键全扫） | 80.1 µs/次 |
| resolvePricing 全扫未命中（最坏） | 81.1–116.5 µs/次 |
| 同上，键 toLowerCase 预计算 | 30.4 µs/次 |
| 同上，按 model 记忆化（Map） | 0.15 µs/次 |
| 1000 请求记录路径（未命中扫描，含 push/slice/computeCost） | 129.7 ms 总（129.7 µs/请求） |
| 1000 请求记录路径（子串命中） | 84.7 ms 总（84.7 µs/请求） |
| JSON.stringify 真实 store 命名空间（227 旧记录+标量，26,729 B） | 148.5 µs/次 |
| JSON.stringify 纯标量命名空间（33 B） | 0.49 µs/次 |
| JSON.stringify 240 记录命名空间（25,169 B） | 263.4 µs/次 |
| `history.slice(-240)`（封顶后每请求一次） | 0.83 µs/次 |
| `totals()` / `spark(last 60)`（每次绘制） | 5.5 / 5.1 µs |
| 写盘 26.7 KB vs 33 B（writeFileSync，OS 层下限） | 6.46 ms vs 0.97 ms/次 |
| pricing.json（366 键，37,824 B）read+parse（每 session.start 一次） | ~1.14 ms |
| 杀 `cmd /c` 后孙进程存活（exp2） | 存活，孤儿 Confirmed |
| runningCmd 两个交叠场景（exp3 逻辑模拟） | 双双重复启动 Confirmed；Set 修复均正确拒绝 |

---

## 改进方案（最小改动路径）

- **S0（语义决策，先行）**：B-1 二选一—— 对齐文档+删两处死读 + README/TODO 修订 + `store.set('usage-history', [])` 清冻结键；或 恢复跨会话窗口（S1 节流 + 键升 v2）。推荐：改动最小、符合 3.7.0 已选的方向。
- **S1（节流写，~6 行）**：`turn.step` 中 cost 写入改为"距上次成功写 ≥10s 或 Δ>$0.50 才 `store.set`"；丢账窗口从每请求变为节流周期（README 加一句）。顺带把 B-3 的写频降一个量级。
- **S2（pricing 记忆化，3 行）**：`const priceMemo = new Map()`；`resolvePricing` 前查、后存；`pricing` 重新加载时 `priceMemo.clear()`。80–120 µs → 0.15 µs。卫生级收益，非必需。
- **S3（防重修复，两处各 4 行）**：`runningCmd` → `Set`（见 B-2 草案），同时可加 `size >= 4` 并发上限（B-7）。
- **S4（输出截断，两处各 1 行）**：`((r.stdout||'').slice(-160) + ' ' + (r.stderr||'').slice(-160)).trim()` 峰值 2×O(输出) → ~320 B；根治待引擎 API。`browserArgv` 派发补 `timeoutMs`（如 15000）。
- **S5（孤儿自保，可选）**：B-5 的超时哨兵提示；根治需引擎树杀，建议向上游反馈。

## 修复顺序建议

1. S3（防重，正确性，4.8 KB 级改动，先于一切性能项）
2. S0(a) + 清冻结键（止住 B-1 污染与 B-3 写放大）
3. S4 + browserArgv 超时（资源边界）
4. S1（写节流）
5. S2、S5、B-8 的 safe 化（清理项）

## 跨报告线索（需 04/05 号代理校对）

- 04（渲染/交互）：每请求一次 `$.ui.invalidate('ui.render')`（`:1284`）在并行子代理高频完成时的引擎重绘成本——本报告只确认调用频率，未测引擎侧重绘开销；`inlineUp/paneUp` 多 surface 行为（B-10）；`:1320` 裸 invalidate 的引擎拒绝策略。
- 05（文档/分发）：README:132 跨会话窗口声明过时；CLAUDE.md 头部"companion mod plugin (`mod/`, v3.7.0)"与 plugin.json 3.8.0 不符；TODO.md C2（`usage-history` last-writer-wins）已随 3.7.0 失效。
- 若任何代理拿到 `claude-code.d.ts`（本机 2.1.309 npm 包只带 sdk-tools.d.ts，未随附）：请核对 `store.set` 的原子性/调度、`ProcessRunOptions.timeoutMs` 超时是否树杀、stdout/stderr 是否有上限——直接决定 B-3/B-5/B-6 的最终定级。

## 被推翻的假设 / 已验证无问题

- **被推翻**：「resolvePricing 366 键全扫描在高频请求下是热点」——实测 80–120 µs/请求，1000 请求累计 130 ms，相对模型请求周期（秒级）完全可忽略。子串命中与未命中同价（最长匹配必须全扫）。仍是值得做的卫生优化（S2），但不是热点。
- **被推翻**：「240 封顶后 `slice(-MAX_POINTS)` 造成 GC 压力」——0.83 µs/次，量级无意义。
- **已验证无问题**：`turn.step` 直通路径——记录严格发生在 `yield*` 完成之后（`:1252-1257`），每个 chunk 零加工；记录段整体 try/catch 且 `return result` 兜底，不可能破流。
- **已验证无问题**：`turn.step` 与 `/ccsl-buttons` 重载并发——`applyConfigText` 对 `buttons/toggle` 做原子引用替换（`:1092-1093`），不改旧数组；重载后 `:1320` invalidate；渲染闭包捕获旧 `b` 对象至多显示一帧旧内容，无撕裂。
- **已验证无问题（附条件）**：`costAll` 写失败漂移——`safe` 吞错后内存继续累加，下次成功写会整体覆盖（自愈）；仅"会话结束前最后一次成功写之后的增量"丢失（S1 会扩大该窗口，需权衡声明）。

## 未验证 / 局限

- 引擎 `$.process.run` 超时的杀进程方式（树杀 or 裸 kill）——二进制含 `taskkill /T`、`killTree` 字符串但调用点无法定位；B-5 停留在 Likely。
- 引擎 `store.set` 的调度（同步写/队列/去抖）与原子性（temp+rename?）——B-3 的 I/O 数字是 OS 层下限，实际引擎成本可能更低。
- 引擎对 run 输出的内部缓冲上限——B-6 引擎侧为 Speculative。
- 热重载是否重求值模块（B-9 的前提）——依据注释与 TODO D 旁证，未实机复现。
- 多 surface（desktop+terminal）同时渲染 AbovePrompt 的实际行为（B-10）。
- I/O 计时受本机 Defender 影响绝对值偏高，相对比值（26.7 KB vs 33 B）可信。
- 所有 `$.` 引擎 API 行为结论均以代码使用面+文件观察为限，未运行 Claude Code 宿主做活体实验（按约束不启动/不干预用户会话）。
