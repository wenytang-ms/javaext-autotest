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

## Phase 3 ✅ Java 扩展测试能力 + 端到端可跑

> 状态：**已完成** · `java-maven.yaml` 8/8 通过

- [x] Wiki Test Plan → YAML 转换
  - [x] `java-basic-editing.yaml` — Basic 场景 (步骤 1-5)
  - [x] `java-maven.yaml` — Maven 场景 (8 步全通过)
- [x] 新增 Driver 操作原语（Java / Language Server 相关）
  - [x] `typeInEditor()` — 编辑器文本输入（Monaco executeEdits API）
  - [x] `setEditorContent()` / `selectAllInEditor()` — 编辑器内容替换
  - [x] `typeAndTriggerSnippet()` — 代码片段触发
  - [x] `waitForLanguageServer()` — 语言服务器就绪轮询
  - [x] `getProblemsCount()` — Problems 面板错误/警告计数（aria-label + Panel fallback）
  - [x] `navigateToError()` / `navigateToNextError()` — 错误导航
  - [x] `applyCodeAction()` — Code Action 执行
  - [x] `triggerCompletion()` / `dismissCompletion()` — 代码补全
  - [x] `goToLine()` — Ctrl+G 行跳转
  - [x] `goToEndOfLine()` — End 键
  - [x] `insertLineInFile()` — 磁盘文件修改 + File: Revert 重载
  - [x] `editorContains()` — Monaco model + 可见 DOM 双重检查
- [x] 新增 Action 模式匹配（16 种）
- [x] 新增验证类型
  - [x] `verifyProblems` — 错误/警告数量（精确 / atLeast 模式 + 轮询等待）
  - [x] `verifyCompletion` — 补全列表验证
- [x] VSCode 1.115 兼容性修复
  - [x] Command Palette 定位器 `.quick-input-box input`（替代 `role="combobox"`）
  - [x] `fill(">" + label)` 保留命令模式前缀
  - [x] `fill(":" + line)` 保留行跳转前缀
- [x] 工作区隔离
  - [x] 自动复制 workspace 到固定临时目录
  - [x] 清理旧临时目录 + 重试删除机制
- [x] 截图系统
  - [x] 每步自动截图（before/after/error）
  - [x] 通过步骤自动清除 before 截图
  - [x] 每次运行清空截图目录
- [x] 事件驱动等待（替代硬编码 `waitForTimeout`）
  - [x] Quick Input widget visible/hidden
  - [x] Suggest widget visible/hidden
  - [x] Workbench ready
  - [x] Tree item visible
- [x] 进程生命周期管理
  - [x] 每次启动清空 user-data 目录（防止窗口恢复）
  - [x] Settings 注入 `window.restoreWindows: none`
  - [x] SIGINT/SIGTERM 信号处理
  - [x] `close()` 重试机制
- [x] action 参数大小写保留（case-insensitive 匹配 + 原始文本提取）
- [x] 路径解析相对于 test plan 文件目录
- [x] Quick Open 重试机制（文件索引未就绪时自动重试）

---

## Phase 4 ✅ 架构解耦 + AI 验证层 + Copilot CLI 集成

> 状态：**已完成**

### 4a. 架构解耦

TestRunner God Class 拆分为独立模块：

- [x] `ActionResolver` — 自然语言 action → Driver 调用（16 种 regex 模式）
- [x] `StepVerifier` — 6 种确定性验证 + LLM 验证策略
- [x] `LLMClient` — Azure OpenAI 客户端封装
- [x] `TestRunner` — 瘦编排层（启动 → 执行 → 截图 → 报告）

### 4b. LLM 截图验证

- [x] Azure OpenAI GPT-4o 集成（screenshot base64 → pass/fail + reasoning + confidence）
- [x] 环境变量配置（`AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_DEPLOYMENT`）
- [x] 未配置时自动跳过（不阻塞测试）
- [x] `--no-llm` CLI 选项强制跳过
- [x] 确定性验证优先执行，LLM 仅处理 `verify` 自然语言字段

### 4c. Copilot CLI 集成

- [x] `AGENTS.md` — 项目级指南（CLI 选项、test plan 列表、截图分析）
- [x] 根目录 `AGENTS.md` — 入口指引

### 待做（AI 增强）

- [ ] AI Action 映射（fallback）— 无匹配 regex 时让 AI 规划 Driver 调用
- [ ] 操作词典扩展 — 从历史记录学习 action → driver 映射

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
- [ ] CI/CD 集成
  - [ ] GitHub Actions workflow 模板
  - [ ] 测试结果上传为 artifact
  - [ ] HTML 报告生成
- [ ] 并行执行 — 多个 scenario 并行跑

---

## Phase 7 🔲 稳定性与扩展

> 状态：**待开始** · 优先级：低

- [ ] 窗口焦点防干扰措施
  - [ ] Headless 模式支持 — Linux 下通过 `xvfb-run` 运行
  - [ ] Windows 虚拟桌面隔离
  - [ ] 对 blur 敏感的组件增加重试逻辑
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
| M2: Java POC | ✅ 完成 | wiki 转 YAML + Java 操作原语 |
| M3: 端到端可跑 | ✅ 完成 | java-maven.yaml 8/8 通过 · 工作区隔离 · 截图 · 事件驱动等待 |
| M4: AI 验证 + 解耦 | ✅ 完成 | ActionResolver / StepVerifier / LLMClient 拆分 · Azure OpenAI 集成 · Copilot CLI AGENTS.md |
| M5: 读 wiki 跑测试 | 🔲 待做 | Copilot CLI 直接读 Markdown → 全自动测试 |
