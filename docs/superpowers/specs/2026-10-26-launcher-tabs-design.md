# 启动器分栏（tabs）+ 快速切换类设计（mod v3.4.0）

日期：2026-10-26 · 状态：已确认（用户选 A）

## 背景与目标

3.3.0 启动器把全部分区纵向平铺，真机反馈：目标太多、高频切换（模式类）没有专属位置、链接只 toast 地址看不见、命令点击后无可见结果、usage/tokens 按钮与状态栏重复。本轮重构为**分栏启动器**：默认只显示一栏（快捷），其它栏点击栏标才展开。

## API 能力事实（2026-10-26，build 2.1.309 实证）

- 权限模式（含 bypassPermissions）：**mods API 无法直接设置**。`$` 无 setter（`$.settings` 只读）；`Button.action` 是入站属性（chord→按钮），`app:` 动作表无模式切换；`tool.call` hook "only tightens"。`setPermissionMode` 为引擎内部/远程通道能力。
- 可一步切换：`/fast`（快速模式）、`/effort` 等引擎斜杠命令可经 `$.prompt.submit` 触发。
- 权限设置最短路径：`$.prompt.submit('/permissions')` 打开权限对话框（两步）。**用户决策：接受，采用 A**；schema 做成通用 `slash` 动作，API 未来开放 setter 时平滑升级。

## 设计

### 分栏结构

- 正文顶部一排**栏标按钮**：`快捷 · 提示词 · 链接 · 命令` + 自定义栏；当前栏高亮（`▸ 名称`），其余暗色；点击切换（`$.ui.invalidate`），不关闭启动器。
- 正文只渲染当前栏的按钮（一行一个，plain，`hotkey: label`）。
- **栏归属按动作类型**：`slash`/`pane` → 快捷；`prompt` → 提示词；`url` → 链接；`run` → 命令；`group` 字段 = **自定义栏名**（多 table 预留即此结构）。自定义栏按首次出现顺序排在四内置栏后。
- 栏状态 `activeTab` 为模块状态，默认第一栏；`/ccsl-buttons` 重载后若当前栏为空则回落到第一栏。
- 热键仅当前栏渲染 → 跨栏天然不冲突。

### 新动作类型

- `{ label, hotkey, slash: "fast" }`：提交 `"/fast"` 后收起启动器并 toast（模式切换 = 回对话）。权限设置即 `{ label: '权限设置', slash: 'permissions' }`。规范化：去前导 `/`、小写、校验 `[a-z0-9-]+`。

### 链接栏 = 收藏夹样式

- url 按钮渲染 `别名` + 暗色截断地址（Button children：`[label, Text(dim, '  '+truncUrl)]`，去协议、42 字符截断），点击打开浏览器。像收藏夹：地址可见、一键直达。

### 命令栏真实效果

- 模块状态 `lastRun = { label, exitCode, tail, at }`；命令完成后写入并 `$.ui.invalidate`，结果以暗色行内联渲染在命令栏下方（`label: exit N · 输出尾部`），toast 保留。

### 模板

- 删除 usage/tokens 按钮（状态栏已覆盖 Σ/TPS；live-label 逻辑一并移除）。usage **面板**按钮保留（sparkline 为状态栏所无）。
- 快捷：usage 面板 / 快速模式(/fast) / 权限设置(/permissions)；提示词：测试并修复、审查改动、解释代码、继续任务；链接：仓库、议题；命令：语法检查、更新价格；misc 示例栏：其他命令(node --version)。

### 错误处理与降级

- `slash` 提交失败 / `process.run` 失败：toast 错误（既有纪律）。全部 `safe()` 包裹， degrade to "not shown"。
- band 内联降级（3.3.0）保持：面板摆不下时同样渲染栏标 + 当前栏。

### 版本与发布

- 3.4.0（package.json / statusline.js VERSION / mod plugin.json 三处联动，check-version.js 校验）。
- 已知待办：3.2.0 推送触发的 publish 工作流失败（run 40193914288）未排查；3.3.0、3.4.0 推送前需先解决。

## 验证

stub 冒烟（%TEMP%，不入仓库）：同步派发（根因回归）、isPlaced:false 内联降级、分栏切换、slash 派发、收藏夹渲染、lastRun 内联、模板无 U/C、四内置栏顺序 + 自定义栏最后；`claude plugin validate`；`npm run check`。
