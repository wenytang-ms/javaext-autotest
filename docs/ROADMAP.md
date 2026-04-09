# Roadmap — VSCode AutoTest

## 总体目标

让 Copilot CLI 直接读取 wiki 中的 Test Plan（Markdown），自动驱动 VSCode 执行端到端测试并验证结果。

---

## Phase 1 ✅ 基础框架搭建

> 状态：**已完成**

- [x] 项目初始化（TypeScript + npm）
- [x] VscodeDriver 核心 — Playwright Electron 启动/关闭
- [x] 基础操作原语
  - [x] `runCommandFromPalette()` — Command Palette 执行
  - [x] `openFile()` — Quick Open 打开文件
  - [x] `getEditorContent()` — 读取编辑器内容
  - [x] `saveFile()` / `pressKeys()` — 保存与快捷键
  - [x] `runInTerminal()` — 终端命令
- [x] UI 交互原语
  - [x] `activeSideTab()` — 侧边栏切换
  - [x] `clickTreeItem()` / `isTreeItemVisible()` — TreeView 操作
  - [x] `selectPaletteOption()` — Palette 选项选择
  - [x] `getNotifications()` — 通知读取
- [x] Snapshot 能力
  - [x] `snapshot()` — A11y 树快照
  - [x] `domSnapshot()` — DOM 快照
  - [x] `screenshot()` — 截图
- [x] 基础验证
  - [x] `isElementVisible()` — 元素可见性
  - [x] `fileExists()` / `fileContains()` — 文件验证

---

## Phase 2 ✅ Test Plan 引擎

> 状态：**已完成**

- [x] YAML Test Plan 解析器（`planParser.ts`）
- [x] Test Plan 验证（`validate` 命令）
- [x] 测试执行引擎（`testRunner.ts`）
  - [x] Setup 阶段 — 扩展加载、workspace 配置、settings 注入
  - [x] Step 顺序执行 — action 匹配 → 执行 → 验证
  - [x] 确定性验证 — `verifyFile` / `verifyNotification` / `verifyEditor`
- [x] CLI 入口（`run` / `validate` 命令）
- [x] JSON 报告输出
- [x] 示例 Test Plan（API Center）

---

## Phase 3 ✅ Java 扩展测试能力（POC）

> 状态：**已完成**

- [x] Wiki Test Plan → YAML 转换
  - [x] `java-basic-editing.yaml` — Basic 场景 (步骤 1-5)
  - [x] `java-maven.yaml` — Maven 场景
- [x] 新增 Driver 操作原语（Java / Language Server 相关）
  - [x] `typeInEditor()` — 编辑器文本输入
  - [x] `setEditorContent()` / `selectAllInEditor()` — 编辑器内容替换
  - [x] `typeAndTriggerSnippet()` — 代码片段触发
  - [x] `waitForLanguageServer()` — 语言服务器就绪轮询
  - [x] `getProblemsCount()` — Problems 面板错误/警告计数
  - [x] `navigateToError()` / `navigateToNextError()` — 错误导航
  - [x] `applyCodeAction()` — Code Action 执行
  - [x] `triggerCompletion()` / `dismissCompletion()` — 代码补全
- [x] 新增 Action 模式匹配（13 种，原 6 种 + 新增 7 种）
- [x] 新增验证类型
  - [x] `verifyProblems` — 错误/警告数量精确匹配
  - [x] `verifyCompletion` — 补全列表验证
- [x] 编译验证通过

---

## Phase 4 🔲 AI 验证层

> 状态：**待开始** · 优先级：高

自然语言 `verify` 字段目前 auto-pass，需要接入 AI 进行 snapshot 判断。

- [ ] AI Snapshot 验证
  - [ ] 将 A11y snapshot 序列化为文本描述
  - [ ] 发送 snapshot + verify 描述到 AI（Copilot CLI / OpenAI）
  - [ ] AI 返回 pass/fail + reasoning + confidence
  - [ ] 低 confidence 时自动截图辅助判断
- [ ] AI Action 映射（fallback）
  - [ ] 无法匹配已有模式时，将 action + snapshot 发送给 AI
  - [ ] AI 返回 Driver 调用序列
  - [ ] 执行 AI 规划的操作
- [ ] 操作词典扩展
  - [ ] 从历史执行记录中学习 action → driver 映射
  - [ ] 支持自定义操作词典（YAML 配置）

---

## Phase 5 🔲 Markdown Test Plan 原生支持

> 状态：**待开始** · 优先级：高

让 Copilot CLI / autotest 直接读取 wiki Markdown 格式的 Test Plan，无需手动转 YAML。

- [ ] Markdown Test Plan 解析器
  - [ ] 解析 `## Scenario` 标题提取场景
  - [ ] 解析有序列表 `1. 2. 3.` 提取步骤
  - [ ] 识别内嵌代码块作为输入数据
  - [ ] 识别 "check" / "verify" / "should" 等关键词提取验证条件
- [ ] 结构化标注方案（可选增强）
  - [ ] 支持 HTML 注释 `<!-- autotest:action ... -->` 嵌入
  - [ ] 保持 Markdown 人可读性
- [ ] Copilot CLI 编排入口
  - [ ] `copilot-test run --wiki-plan Test-Plan.md --scenario "Basic"`
  - [ ] 自动提取指定场景 → 转换为内部 TestPlan 对象 → 执行
- [ ] Wiki Test Plan 全场景覆盖
  - [ ] Basic (全部 9 步)
  - [ ] Maven / Gradle / Single file
  - [ ] IntelliCode / Debugger / Test Runner / Maven for Java
  - [ ] Java Dependency Viewer / Extension Pack

---

## Phase 6 🔲 运行环境与 CI 集成

> 状态：**待开始** · 优先级：中

- [ ] Attach 模式 — 连接已运行的 VSCode（CDP 端口）
- [ ] 项目自动准备
  - [ ] 自动 clone GitHub 测试项目
  - [ ] JDK 版本检测与切换
  - [ ] workspace 隔离（每次测试使用临时目录）
- [ ] CI/CD 集成
  - [ ] GitHub Actions workflow 模板
  - [ ] 测试结果上传为 artifact
  - [ ] HTML 报告生成
- [ ] 并行执行 — 多个 scenario 并行跑

---

## Phase 7 🔲 稳定性与扩展

> 状态：**待开始** · 优先级：低

- [ ] 窗口焦点防干扰措施
  - [ ] 关键操作（补全菜单、Code Action、Quick Pick）前自动调用 `page.bringToFront()` 确保窗口前台
  - [ ] Headless 模式支持 — Linux 下通过 `xvfb-run` 运行，无需真实显示器
  - [ ] Windows 虚拟桌面隔离 — 测试在独立虚拟桌面运行，避免与用户操作冲突
  - [ ] Electron `--headless` 实验性支持（适用于无 UI 验证的场景）
  - [ ] 对 blur 敏感的组件（补全列表、Quick Pick）增加重试逻辑：检测到菜单意外关闭时自动重新触发
- [ ] 重试机制 — 步骤失败自动重试（可配置次数）
- [ ] 条件跳过 — 根据平台/JDK版本跳过步骤
- [ ] 交互模式 (`--interactive`) — 逐步执行 + 手动确认
- [ ] Test Plan 自动修复建议 — 失败后 AI 建议修改
- [ ] 扩展到其他 VSCode 扩展（非 Java）
- [ ] 单元测试覆盖（vitest）

---

## 里程碑总览

| 里程碑 | 状态 | 关键交付 |
|--------|------|---------|
| M1: 框架可用 | ✅ 完成 | CLI + YAML Plan + Playwright Driver |
| M2: Java POC | ✅ 完成 | wiki 转 YAML + Java 操作原语 + 编译通过 |
| M3: 端到端可跑 | 🔲 待做 | 实际启动 VSCode 跑通 Basic 场景 |
| M4: AI 验证 | 🔲 待做 | 自然语言 verify → AI 判断 pass/fail |
| M5: 读 wiki 跑测试 | 🔲 待做 | Copilot CLI 直接读 Markdown → 全自动测试 |
