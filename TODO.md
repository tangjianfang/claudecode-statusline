# 伴随 mod（v3.2.0）Review 与待办

> 范围：`mod/hooks/register.mjs`（499 行，基于提交 `16bb22a`）。重点是 3.2.0 新增的 **buttons pane** 与 band 切换。
> 依据：`claude plugin validate mod` 通过；API 对照 Claude Code 2.1.310 自带的 `claude-code.d.ts` 官方类型声明；Windows 相关两项用 Node 实测过。
> 本文只列待办，**没有改任何代码**。

## 处置记录（2026-10-26，v3.3.0–v3.8.0）

清单在 3.3.0→3.7.0 的真机迭代中已消化大半，剩余项在 3.8.0 一并处置：

| # | 处置 | 说明 |
| --- | --- | --- |
| A1 | ✅ 3.8.0 | 首按钮 `autoFocus`；`/ccsl` 命令入口（从输入框触发必得键盘）；pane 热键提示见 README。实机热键表现仍待验 |
| A2 | ✅ 3.6.0/3.8.0 | `isFilled` 检查与 toast（3.6.0）；close 先 await 再 fill、无裸 submit（3.8.0）；submit 已整体改为 fill+Enter 确认制 |
| A3 | ✅ 3.8.0 | 重载后 `invalidate`；失败带原因并沿用上次配置；接受/跳过计数（含热键去重）；全无效不静默；pane 顶部 ⚠ 行；先 apply 再 write |
| A4 | ✅ 3.8.0 | buttons 面板顶部 usage 概览行；usage 面板 `← 返回启动器`（b） |
| A5 | ✅ 3.8.0 | `/ccsl` 命令 + README 键位示例；`band:false` 配置 |
| A6 | ✅ 3.6.0/3.8.0 | 提示词一律填入确认（3.6.0）；run 运行中防重复（3.8.0） |
| B1 | ✅ 3.5.x | `flexWrap`、`rows`（按内容+边框估算）、`bodyColumns` 驱动的等宽卡片 |
| B2 | ✅ 3.3.0/3.8.0 | plain 热键行；`(send)` 标记已随确认制移除；重复热键丢弃并提示 |
| B3 | ❌ 不做 | 卡片布局已经用户实机验收；紧凑单行与之冲突 |
| B4 | ◐ | `isWorking` 运行中标记已做（3.7.0）；band 实时数据不做——用户在 3.4.0 轮明确要求移除与状态栏重复的 U/C |
| B5 | ◐ 3.8.0 | lastRun 用主题色 `success`/`error`；分区四色为用户验收的外观，保留 |
| B6 | ✅ 3.8.0 | 概览行并入 buttons 面板；sparkline 自适应留待需要时再做 |
| B7 | ◐ | 按钮 emoji 已全禁（3.5.2）；分区头 emoji 保留（渲染正常且已验收）；配置错误行已做；标题已是 `✳ 启动器` |
| C1 | ✅ 3.8.0 | win32 下 `npm/npx/yarn/pnpm/bun` 派发经 `cmd /c`；URL 改 `rundll32 url.dll,FileProtocolHandler`（不经 shell，`&` 安全）。宿主行为待实机 |
| C2 | ✅ 3.4.0/3.8.0 | tokens 按钮已删；面板明示「最近N次请求(含子代理)」；live 标签逻辑已随 buttonLabel 移除 |
| C3 | ✅ 3.8.0 | 模板 `npm run check` 换成通用 `git log --oneline -5`；README 增配置安全说明；措辞已改「every call wrapped in safe()」 |
| D | ✅ 多数 | fmt 进位、码点截断（3.5.0）、保留组名前缀、pane 标题用按钮名、`usageFrom(result)`；matcher 化 Pane hook 与 `CLAUDE_CONFIG_DIR` 暂缓（见下） |

**暂缓**：Pane hook 的 `requestId` matcher 化（现运行时判判工作正常，matcher 是否支持该键未验证，不冒险）；`CLAUDE_CONFIG_DIR`（需与 statusline.js 统一处理，另议）；`claude plugin test` 测试基建（仓库无测试设施是明文设计，纯逻辑以 %TEMP% 冒烟脚本覆盖）。

## 0. 怎么读这份文档

| 标记 | 含义 |
| --- | --- |
| `[类型]` | 已对照官方类型声明确认 |
| `[实测]` | 已在本机用 Node 实测，但 Claude Code 宿主的行为没验证 |
| `[推断]` | 由文档推出，**必须实机验证**后再动手 |
| `[视觉]` | 只能用眼睛确认，按你的全局规则我不自行截图，改完只做构建检查，由你自己看 |

优先级：**P0** 影响主流程，先修；**P1** 明显缺陷；**P2** 体验和一致性；**P3** 清理。

### 总览

| # | 事项 | 优先级 | 类别 | 依据 |
| --- | --- | --- | --- | --- |
| A1 | 点 `☰` 打开 pane 后热键可能不生效 | P0 | 交互 | `[类型][推断]` |
| A2 | prompt 按钮：close 与 fill 无顺序、不检查 `isFilled`、submit 无 catch | P0 | 交互/健壮性 | `[类型]` |
| A3 | `/ccsl-buttons` 重载后不刷新、不报错、静默丢弃条目 | P0 | 交互/健壮性 | `[类型]` |
| A4 | usage 与 buttons 两个 pane 互相切换很绕 | P1 | 交互 | `[类型]` |
| A5 | 键盘入口：`m` 只有 band 获得焦点才生效 | P1 | 交互 | `[类型]` |
| A6 | `submit:true` 与 `run` 按钮缺少误触保护 | P2 | 交互/安全 | 代码阅读 |
| B1 | 按钮行不换行、不传 `rows`/`columns`，pane 可能被截断 | P1 | 布局 | `[类型][视觉]` |
| B2 | 热键在 pane 里看不见 | P1 | 样式 | `[类型]` |
| B3 | 紧凑布局：标题与按钮同行，省掉空行 | P1 | 布局 | `[视觉]` |
| B4 | 切换按钮反映开/关状态，band 带一行实时数据 | P2 | 样式 | `[类型]` |
| B5 | 颜色改用主题色（ThemeKey） | P2 | 样式 | `[类型]` |
| B6 | usage 内容并进 buttons pane 顶部 | P2 | 布局 | 设计建议 |
| B7 | 图标宽度、标题、空状态、错误提示 | P2 | 样式 | `[视觉]` |
| C1 | Windows：`npm` 不能直接 spawn；`start` 遇 `&` 被截断 | P1 | 正确性 | `[实测]` |
| C2 | 统计口径与状态栏 Σ 不一致 | P2 | 数据 | 项目 CLAUDE.md |
| C3 | 默认模板含作者仓库专属内容 | P2 | 分发 | 代码阅读 |
| D1 | 小问题与清理 | P3 | 清理 | 见 D 节 |

---

## A. 交互与切换

### A1（P0）点 `☰` 打开 pane 后热键可能不生效 `[类型][推断]`

- 位置：`register.mjs:325-329`（`$.ui.open({ focus: true })`）。
- 依据：`PaneOpenArgs.focus` 是「请求，不是授予」，只有「提示符持有键盘且输入框为空」时才给；band 上的元素被人持有时会被拒绝，pane 不带键盘打开。`ButtonProps.hotkey` 也写明 band 在 ctrl+x tab、点击后才持有焦点。点 `☰` 或按 `m` 都满足「band 被持有」。
- 后果：打开 pane 后直接按 `t`、`u` 没反应，要先点进 pane 或按 ctrl+x tab。
- [ ] **先实机验证**：点 `☰`，再按 `u`。
- [ ] 若确认失效，采用其一或组合：
  - [ ] 新增「切换 pane」的命令（见 A5），从输入框触发能拿到焦点，并绑定快捷键作为主入口。
  - [ ] toggle 的 toast 提示「点击 pane 或 ctrl+x tab 获得键盘」。
  - [ ] 如果始终拿不到焦点，在 pane 底部提示改成「点击按钮 / ctrl+x tab 聚焦后可用热键」，不要写成热键直接可用。
- 注意：`$.ui.focus` 在「站点没持有键盘」时返回 `{ deny }`，没法靠它补救。

### A2（P0）prompt 按钮流程有三处漏洞 `[类型]`

位置：`register.mjs:393-407`。

- [ ] `close` 没 await 就紧接着 `fill`，两者无顺序保证。改为 `await $.ui.close(...)` 后再 `fill` / `submit`（`onPress` 可以是 async）。
- [ ] 检查 `fill` 返回的 `isFilled`。`false` 时按 `refusal`（`no_composer`、`dialog`）给出对应 toast，不要无条件说 "filled"。
- [ ] `$.prompt.submit(...)` 没 await 也没 `.catch`，被 hook 拒绝会产生未处理的 rejection。至少 `.catch(err => toast)`，官方示例写法是 `void $.prompt.submit(...)`。
- [ ] "sent" 的 toast 不准确：文档说 submit 要等会话空闲后才作为新 turn 发出。改为「已排队/已发送」或在 `submit` resolve 之后再 toast。

### A3（P0）`/ccsl-buttons` 重载：不刷新、不报错、静默丢弃 `[类型]`

位置：`register.mjs:285-294`、`:146-182`。

- [ ] 重载成功后调用 `$.ui.invalidate('ui.render')`。文档说「重绘复用旧答案」，现在只有 `turn.step` 会触发 invalidate，所以编辑配置后 band 和已打开的 pane 会一直显示旧内容。
- [ ] 重载失败要给原因（JSON 的 `err.message`、出错位置），不要只回 "could not load"。
- [ ] `normalizeButton` 丢掉条目时记录原因（缺 label、热键非小写字母或数字、url 不是 http(s) 开头、`run` 不是字符串数组、没有动作字段），`/ccsl-buttons` 返回「接受 N / 共 M 条，跳过：…」。
- [ ] 全部条目被丢弃时不要悄悄回退到 2 个默认按钮并回报 "loaded 2"，应当明确提示。
- [ ] `session.start` 同理：配置解析失败时，在 pane 里显示一行警告（见 B7），而不是静默。
- [ ] `:229-230` 先 `fs.write` 再 `applyConfigText(template)`，写文件失败就连模板都不应用。顺序改为先 apply 再 write（write 失败只 toast）。

### A4（P1）usage 与 buttons 两个 pane 互相切换很绕 `[类型]`

- 现状：panes 是「一个显示、其余是标签页」。在 buttons pane 里按 `usage`，usage pane 打开并盖住它；buttons pane 退到标签页，没有明显的返回路径。此时再点 band 的 `☰`，因为 `panes()` 里还有 buttons pane，反而会把它**关掉**。
- [ ] 在 usage pane 里加「← 返回按钮」（热键 `b`），再 `$.ui.open` buttons pane。
- [ ] 或者按 B6 把 usage 概览并进 buttons pane 顶部，普通场景不再需要第二个 pane，`/ccsl-usage` 保留作详情页。
- [ ] 重新定义 `☰` 的语义：任一 ccsl pane 打开时，是关闭全部，还是回到 buttons，选一种并写进 README。

### A5（P1）键盘入口 `[类型]`

- 现状：toggle 默认热键 `m`（`:117`）只有 band 获得焦点后才生效，输入框里按不出来。文档明确：字母键不会从输入框触发；裸数字键在空输入框里会「按下」band 按钮，**会抢走用户想输入的开头数字，不建议改成数字**。
- [ ] 新增命令用于切换 buttons pane（例如 `/ccsl`，**命名待你定**），README 里给出键位绑定示例（沿用 README 里 `meta+u -> command:ccsl-usage` 的写法）。从输入框触发能拿到焦点，同时解决 A1。
- [ ] 评估 `Button.action`（绑定引擎已有 keybinding 动作的按键）能否借用，但只能用引擎已有的动作名，未知名称会被拒绝，大概率不适用，仅记录。
- [ ] 配置里增加 `"band": false`，让只用命令/键位的用户不再占用 band 那一行（见 B4）。

### A6（P2）误触保护 `代码阅读`

- [ ] 配置里支持 `confirm: true`：第一次按下只把按钮变成「再按一次确认」，几秒内再按才执行；默认给 `submit:true` 的提示词和有副作用的 `run` 开启。
- [ ] 同一个 `run` 按钮运行期间忽略重复按下，并在按钮上显示「运行中…」；现在连按两次会启动两个进程（`timeoutMs: 600000`，没有取消）。
- [ ] 「发送即执行」用统一视觉标记，见 B2 的 `⏎`，不再用 `(send)` 后缀。

---

## B. 布局与样式美化（重点）

> 下面是用官方元素能力做的设计：`Box` 支持 `gap`、`flexWrap`、`rowGap`、`padding`、`borderStyle`、`backgroundColor`、`hover`；`Button` 支持 `plain`、`variant: 'primary'`、`dimColor`、`autoFocus`、`children`（字符串和 `Text`）；`Text` 支持 `bold`、`color`、`dimColor`；还有 `Input` 元素。
> 所有示意图都是**手绘，没有实机渲染**；样式细节要你看过再定。

### B1（P1）按钮行换行，并按内容给 pane 尺寸 `[类型][视觉]`

- 现状：每个分区的按钮行是 `flexDirection: 'row'`，没有 `flexWrap`（`:437`）；`$.ui.open` 没传 `rows`、`columns`（`:325`、`:420`）。默认内联 pane 只有终端高度的 1/3，docked 宽度最多 45%。默认模板 5 个分区约 15 行，中文标签又是双宽，窄屏很可能被截断。
- [ ] 按钮行加 `flexWrap: 'wrap'`。
- [ ] 打开 pane 时传 `rows`（按分区数估算，设上限）和 `columns`（例如 46–52）。
- [ ] 用 `Pane` 的 `e.props.bodyColumns`、`e.props.placement` 选择布局：宽则紧凑（B3），窄则标题单独一行。
- [ ] 把手插的 `Text(' ')` 间隔换成 `gap: 1`（按钮之间）和 `rowGap`（分区之间）。减少元素和 key 数量，也不需要 `ccsl-sec-sp-*` 这类拼出来的 key。
- [ ] `Text(' ')` 空行换成 `marginTop`/`rowGap`，不再占整整一行元素。

### B2（P1）让热键可见，并区分「发送即执行」 `[类型]`

- 现状：按钮画成 `[ 标签 ]`，pane 里完全看不到热键，用户无从发现；send 类只在标签后缀 `(send)`。
- 方案（两选一，先试 a）：
  - a. 用 `Button` 的 `children`：`{label} <Text dimColor>{hotkey}</Text>`；发送即执行的再加一个 `<Text color="warning">⏎</Text>`。
  - b. 菜单风格：`plain` 按钮，终端画成「强调色热键 + 冒号 + 标签」，如 `u: usage`。省宽度，但注意 `plain` 优先于 `variant`。
- [ ] 按钮的 `key` 不再用 `hotkey || label` 拼接，改成稳定的序号或哈希，避免重复热键导致 key 冲突（见 D1）。
- [ ] 第一个按钮加 `autoFocus: true`，pane 获得键盘时焦点环从它开始。

示意（紧凑模式，**未实机渲染**）：

```
 面板    [ usage 12k  u ]  [ tokens 38k  c ]
 提示词  [ 测试并修复 ⏎  t ]  [ 审查改动  r ]  [ 解释代码  e ]  [ 继续任务 ⏎  n ]
 链接    [ 仓库  o ]  [ 议题  i ]
 命令    [ 语法检查  k ]  [ 更新价格  p ]
 misc    [ 其他命令  x ]
 编辑 ~/.claude/ccsl-buttons.json · /ccsl-buttons 重载 · Esc 关闭
```

### B3（P1）紧凑布局：标题与按钮同行 `[视觉]`

- 现状：每个分区 = 标题行 + 按钮行 + 空行，5 个分区约 15 行，而内联 pane 默认只有 1/3 高度。
- [ ] `bodyColumns >= 约 60` 时，标题放在按钮行最左（固定宽度对齐），5 个分区只占 5 行；窄屏回退到现在的「标题单独一行」。
- [ ] 去掉分区之间的空行，用 `rowGap` 或不留间隔。
- [ ] 提示行（编辑路径、重载、Esc）保持一行，窄屏时缩成 `Esc 关闭 · /ccsl-buttons 重载`。

### B4（P2）切换按钮反映状态，band 带实时数据 `[类型]`

- 现状：band 只有一个 `☰`，永远占一行，且不反映 pane 是否打开。
- [ ] 渲染时读 `$.ui.panes()`：pane 打开时按钮画成 `✕`（或 `▾`），并用 `variant: 'primary'`；关闭时 `☰`。打开/关闭之后调用 `$.ui.invalidate('ui.render')`。
- [ ] band 在按钮右侧加一行 dim 的实时信息，让这一行有用：`out 12k · 38 req`。数据来自已有的 `totals()`。
- [ ] 根据 `e.props.isWorking` 显示「运行中」的小提示（可选）。
- [ ] 提供 `"band": false`（见 A5），完全关掉这一行。
- [ ] 保留 survey 让位逻辑（`:302`）。

示意（**未实机渲染**）：

```
 [ ☰ ]  out 12k · 38 req                    关闭时
 [ ✕ ]  out 12k · 38 req                    打开时（primary 强调）
```

### B5（P2）颜色改用主题色 `[类型]`

- 现状：usage pane 用 `cyan`、`green`、`magenta`、`yellow` 这类写死的颜色（`:481-492`），不跟随用户主题。
- [ ] 改用 `ThemeKey`：`claude`、`success`、`suggestion`、`warning`、`subtle`、`error`。
- [ ] 分区标题用 `bold` + `color: 'subtle'`；危险动作的标记用 `warning`；错误用 `error`。

### B6（P2）usage 概览并进 buttons pane `设计建议`

- [ ] buttons pane 顶部加一块「概览」：sparkline + `req / out / in / cacheR / cacheW`，一个 pane 看全，不再来回切（同时解决 A4）。
- [ ] `usage` 与 `tokens` 两个按钮合并为一个，打开详情页。
- [ ] sparkline 宽度按 `bodyColumns` 自适应，不再固定取最近 60 点；0 值画成 `·` 或空格，而不是和很小的值同样的 `▁`。
- [ ] 合计行用 `gap: 2` 代替每段末尾手写的空格，窄屏用 `flexWrap: 'wrap'`。

示意（**未实机渲染**）：

```
 out/req ▁▂▃▅▇▅▃▂▁▂▄▆
 req 38 · out 12k · in 3k · cacheR 8.1M · cacheW 240k
 ──────────────────────────────────────────────
 面板    [ 详情  u ]
 ...
```

### B7（P2）图标、标题、空状态与错误提示 `[视觉]`

- [ ] 分区标题的图标（`⌨ ✏ 🔗 $`）在不同终端里宽度不一致（emoji 常按双宽），对齐会错位。改成单宽符号（如 `▸`、`↗`、`$`）或不用图标，标题统一用 `bold`。
- [ ] 标题与分区之间可以画一条 `─` 的细线，宽度取 `bodyColumns`；不要给每个分区套 `borderStyle` 边框，每个多占 2 行，内联 pane 高度不够。
- [ ] Pane 标题 `Buttons` 改成「快捷操作」或 "Quick actions"（多个 pane 时才作为标签显示）。
- [ ] 配置解析失败时，在 pane 顶部用 `error` / `warning` 色画一行 `⚠ 配置错误：…`（与 A3 联动），而不是只靠命令的返回文本。
- [ ] 无按钮或全被丢弃时画一个明确的空状态，而不是悄悄显示默认按钮。
- [ ] 中英文混用：标签、模板、提示行目前中英混排，决定一种默认语言（或加 `lang` 配置）。
- [ ] 按钮很多（比如 >12）时，可用 `Input` 元素做过滤框，低优先级，按需再做。

---

## C. 正确性与数据

### C1（P1）Windows 上两个调用方式有隐患 `[实测]`

- 位置：`register.mjs:134-135`（模板里的 `npm`）、`:208-212`（`browserArgv`）。
- [ ] `$.process.run` 不走 shell。我在本机用 Node 直接 spawn `npm`，结果 `ENOENT`（它是 `npm.cmd`）。要验证 Claude Code 宿主是否同样；若是，模板里改成 `['cmd','/c','npm',…]`，或按平台生成模板。
- [ ] `cmd /c start "" <url>`：URL 里有 `&` 且没有空格时，Node 不加引号，`&` 之后的内容被 cmd 当成新命令（我用 `echo` 实测过）。改为 `rundll32 url.dll,FileProtocolHandler <url>`，不经过 cmd。
- [ ] 无论哪种，`url` 校验保持只允许 http(s)。
- 宿主对 Windows 命令行的处理没验证：先在真实会话里点 "语法检查" 和一个带 `&` 的链接。

### C2（P2）统计口径与状态栏不一致 `项目 CLAUDE.md`

- 位置：`register.mjs:372-373`、`:250-274`。
- [ ] "tokens" 按钮把 `cacheR` 算进总数；本项目 CLAUDE.md 明确说状态栏的 Σ 要排除 cache-read（每轮重复，会虚高）。统一口径，或明确分开写 `in/out/cacheR/cacheW`，不要再出现一个含糊的「tokens」。
- [ ] 总计是 `$.store` 里最近 240 条的滚动窗口：跨会话保留，并且包含子 agent 的 step，却被画成像会话累计值。决定语义：只统计主会话（用 `e.agentId` 过滤）或分别统计，并在 pane 里写明「最近 N 次请求」。
- [ ] 两个会话同时运行时，`usage-history` 是最后写入者覆盖；至少在文档里说明。
- [ ] 按钮标签靠 `hotkey === 'u'` 或 `'c'` 判断是否显示实时数字（`:371-373`），用户改了热键就失效。改成配置里的显式字段（例如 `live: 'out' | 'total'`）。

### C3（P2）默认模板不适合分发给所有用户 `代码阅读`

- 位置：`register.mjs:120-142`（`configTemplate`）。
- [ ] 模板会写进每个用户的 `~/.claude/ccsl-buttons.json`，但里面有作者仓库的链接，以及 `npm run update-pricing`、`npm run check`；在别的项目里会报错，或运行那个项目自己的同名脚本。
- [ ] 默认模板只保留通用项（usage、通用提示词、`node --version`），仓库专属项放进 README 的示例片段，由用户自己加。
- [ ] 「测试并修复」这类 `submit:true` 的提示词默认改成填入而不是直接发送，或默认 `confirm: true`（见 A6）。
- [ ] 在 README 说明：该配置文件等于「按一下就执行宿主命令」的入口，模型或别的进程若能写它，需要留意（风险不高，但值得知道）。
- [ ] README 与 CLAUDE.md 里的「每个 API 调用都做了特性检测」不完全属实（只有 `safe()` 和 try/catch，`prompt.submit` 还是裸调用）。要么补齐，要么改措辞。

---

## D. 小问题与清理（P3）

- [ ] `fmt` 在边界上有错：`fmt(999999)` 得到 `1000k`，应该进位到 `1.0M`；`k` 档位小于 10k 时可以保留一位小数（`1.5k`）。
- [ ] `normalizeButton` 不检查热键重复：重复热键「后者生效」（文档），但 `key` 会撞（`:379`），可能让整棵树校验失败，整个 pane 回退到引擎默认（空白）。重复时丢弃后者的热键并记录。
- [ ] 自定义 `group` 如果叫 `pane`、`prompt`、`url` 或 `run`，会和内置分区重名，出现重复 section key。保留这四个名字，或给自定义分组加前缀。
- [ ] `pane` 动作只对本 mod 自己画的 pane（`ccsl-usage`、`ccsl-buttons`）有意义，`title` 还硬编码成 `'Usage'`（`:420`），会把别的 pane（包括 `ccsl-buttons` 自己）改名。标题改为按 pane 取，或限制 `pane` 只能取这两个值，并在 `normalizeButton` 里校验。
- [ ] `turn.step` 里的 `else { result = await n }`（`:255-257`）是死代码：流式事件的 `next(e)` 一定是 stream。改成官方写法 `const result = yield* next(e)`。
- [ ] 两个 `ui.render` 的 Pane hook 都靠 `e.requestId` 判断，改用 matcher `{ component: 'Pane', requestId: ID }`，由引擎分发。
- [ ] `usageFrom(e)`：`TurnStepInput` 上没有 `usage`，`usageFrom(e) ||` 可以删，只读 `result.usage`。
- [ ] `normalizeButton` 里 `label.slice(0, 24)` 可能把 emoji 的代理对切断。按码点切，或不截断。
- [ ] 重载时 `buttons`、`toggle` 回到 `null`，依赖 `session.start` 重新读取；确认热重载路径下顺序没问题（`session.start` 会随重载再次触发，文档已说明）。
- [ ] 配置路径写死 `~/.claude/`，没考虑 `CLAUDE_CONFIG_DIR`。statusline.js 同样；是否统一处理另议。
- [ ] 补测试：官方有 `claude plugin test`（参考 `pane.test.tsx`）。至少覆盖 `normalizeButton`、`applyConfigText`、`fmt`、`sectionOrder`。这些是纯函数，改成从 `register.mjs` 导出，或抽到同目录的辅助文件，注意 `$` 名词规则（不能把 `$` 传给辅助函数）。

---

## E. 建议的执行顺序

**3.2.1（修复，不改外观）**
1. 先实机验证 A1 / C1（点 `☰` 后热键是否可用；`npm` 与带 `&` 的链接在 Windows 宿主是否正常）。
2. A2 → A3 → C1 → D1 中的 `fmt`、重复热键、`pane` 标题硬编码、死代码。
3. A5 的命令入口（若 A1 确认失效，这一项升为 P0）。

**3.3.0（交互与外观）**
4. B1 + B2 + B3：换行、尺寸、热键可见、紧凑布局。
5. B4 + B5 + B6：状态感知的切换按钮、主题色、概览并入 buttons pane（顺带解决 A4）。
6. A6 + C2 + C3：误触保护、统计口径、精简默认模板。

### 发版同步（沿用之前提交的做法）

- [ ] 同步 `mod/.claude-plugin/plugin.json`、`package.json`、`statusline.js` 的 `VERSION`；`npm run check` 会校验后两者一致。
- [ ] 更新 `README.md`（mod 小节）、`CLAUDE.md`（mod 小节）、`CHANGELOG.md`（`[Unreleased]` 里补一条）。
- [ ] 检查：`npm run check`、`claude plugin validate mod`。

---

## F. 验收清单（需要你自己看）

> 按你的全局约定：我改完只跑构建/校验，下面这些视觉与交互项由你实机确认。

- [ ] 点 `☰` 后 pane 能否收到热键（A1）。
- [ ] 窄终端、docked 与内联两种模式下，按钮行是否换行、分区是否被截断（B1、B3）。
- [ ] 中文标签、emoji 与对齐（B7）。
- [ ] 编辑配置后 `/ccsl-buttons`，band 和已打开的 pane 是否立即更新（A3）。
- [ ] 配置写错 JSON 时，是否有清晰的错误提示（A3、B7）。
- [ ] 提示词按钮：pane 关闭后输入框里确实有内容；被拒绝时 toast 与实际一致（A2）。
- [ ] Windows：`语法检查` 按钮、带 `&` 的链接（C1）。
- [ ] 开/关状态下 `☰` 的外观，以及连续切换是否正常（B4）。
- [ ] 主题切换后颜色是否跟随（B5）。

## 附：依据速查

| 结论 | 官方类型声明里的位置（`claude-code.d.ts`） |
| --- | --- |
| `focus` 是请求不是授予 | `PaneOpenArgs.focus`（约 7595 行附近） |
| 字母热键只在站点持有键盘时生效 | `ButtonProps.hotkey`（约 1110 行）、`Button` props（约 9873 行） |
| `$.ui.panes()` 是引擎记录，热重载后仍在 | `ui.panes` 注释（约 2555 行） |
| 重绘复用旧答案，需要 `invalidate` | `ui.render` 事件说明（约 4096 行）、`invalidate`（约 2383 行） |
| `prompt.submit` 等会话空闲后才作为新 turn | `prompt.submit` 注释（约 3015 行） |
| `prompt.fill` 返回 `isFilled`、`refusal` | `PromptFilled`（约 8978 行） |
| `process.run` 不走 shell | `process.run` 注释（约 3587 行） |
| `Box` 的 `gap`、`flexWrap`、`borderStyle` | `BoxProps`（约 986-1020 行） |
| `Button` 的 `children`、`plain`、`variant`、`role`、`autoFocus` | `ButtonProps`（约 1093 行起） |
| `ThemeKey` 列表 | 约 13455 行 |
| `TurnUsage` / `ModelUsage` 字段 | 约 14594 行、6606 行 |
