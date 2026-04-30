# VSCode AutoTest

AI 驱动的 VSCode 扩展 E2E 测试框架。

用户提供 YAML 格式的 Test Plan → 框架自动启动 VSCode → 执行操作 → 验证结果。

> **目标**：让 Copilot CLI 直接读取 wiki 中的 Test Plan，自动完成 VSCode 扩展的端到端测试。

---

## 快速开始

```bash
# 安装依赖
npm install

# 编译
npm run build

# 验证 test plan 格式
npx autotest validate test-plans/java-maven.yaml

# 执行测试（含截图 + JSON 报告）
npx autotest run test-plans/java-maven.yaml --output results.json

# 自定义截图输出目录
npx autotest run test-plans/java-maven.yaml --output results.json --screenshots ./my-shots
```

### 前置条件

- Node.js ≥ 18
- JDK 已安装（测试 Java 扩展时需要）
- vscode-java 仓库已 clone 到本地（test plan 中引用了其测试项目）

---

## 核心架构

```
┌─────────────────────────────────────────────────────┐
│             Test Plan (YAML / Markdown)              │
│  描述测试步骤 + 预期结果，不包含硬编码 locator        │
└──────────────────┬──────────────────────────────────┘
                   │  planParser.ts
                   ▼
┌─────────────────────────────────────────────────────┐
│              TestRunner (编排层)                      │
│  启动 VSCode → 逐步执行 → 截图 → 报告               │
│                                                     │
│  ┌──────────────────┐  ┌─────────────────────────┐  │
│  │  ActionResolver   │  │     StepVerifier        │  │
│  │  自然语言 → Driver │  │  确定性验证 + LLM 验证  │  │
│  │  (16 种 regex)    │  │  (6 种策略)             │  │
│  └────────┬─────────┘  └──────────┬──────────────┘  │
│           │                       │                  │
│           │              ┌────────┴────────┐         │
│           │              │    LLMClient    │         │
│           │              │  Azure OpenAI   │         │
│           │              │  screenshot →   │         │
│           │              │  pass/fail      │         │
│           │              └─────────────────┘         │
└───────────┼──────────────────────────────────────────┘
            ▼
┌─────────────────────────────────────────────────────┐
│           VscodeDriver (操作原语 SDK)                 │
│  基于 Playwright Electron + @vscode/test-electron    │
│  工作区隔离 · 事件驱动等待 · 进程生命周期管理          │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│           Playwright Electron Runtime                │
│  启动 VSCode 进程，提供 Page 对象                    │
└─────────────────────────────────────────────────────┘
```

---

## 编写 Test Plan

### 基本结构

```yaml
name: "我的测试"
setup:
  extension: "my-extension"
  extensionPath: "./path/to/extension"
  vscodeVersion: "stable"
  workspace: "./test-workspace"   # 相对于 test plan 文件的路径
  timeout: 60
  settings:                       # 可选：注入 VSCode settings
    editor.fontSize: 14

steps:
  - id: "step-1"
    action: "执行命令 My Extension: Hello"
    verifyNotification: "Hello World!"
```

> **路径解析**：`workspace` 和 `extensionPath` 相对于 test plan 文件所在目录解析，不依赖 CWD。

### 支持的 Action（自然语言 → Driver 映射）

| Action 写法 | 映射操作 | 示例 |
|-------------|---------|------|
| `执行命令 XXX` / `run command XXX` | Command Palette 执行 | `执行命令 Java: Force Java Compilation` |
| `打开文件 XXX` / `open file XXX` | Quick Open 打开文件（含重试） | `打开文件 Foo.java` |
| `点击侧边栏 XXX tab` | 切换侧边栏 Tab | `点击侧边栏 Explorer tab` |
| `展开/点击 XXX 节点` | TreeView 操作 | `展开 APIs 节点` |
| `expandTreeItem XXX` / `展开树节点 XXX` | 只展开已折叠的 TreeView 节点 | `expandTreeItem Lifecycle` |
| `clickTreeItemAction <item> <label>` / `点击树节点按钮 <item> <label>` | 点击 TreeView 节点右侧 hover/inline action | `clickTreeItemAction compile Run` |
| `collapseWorkspaceRoot` / `折叠工作区根节点` | 折叠 Explorer 中第一个展开的 workspace root，给其他 view 腾空间 | `collapseWorkspaceRoot` |
| `collapseSidebarSection XXX` / `折叠侧边栏区域 XXX` | 折叠 Explorer 侧边栏区域 | `collapseSidebarSection OUTLINE` |
| `选择 XXX 选项` | Palette 选项选择 | `选择 Full 选项` |
| `等待 N 秒` / `wait N seconds` | 等待指定时间 | `等待 5 秒` |
| `saveFile` / `保存文件` | Ctrl+S 保存 | `saveFile` |
| `goToLine N` / `跳转到行 N` | Ctrl+G 跳转行 | `goToLine 15` |
| `goToEndOfLine` / `跳转到行尾` | End 键 | `goToEndOfLine` |
| `waitForLanguageServer` | 等待 LS 就绪 | `waitForLanguageServer` |
| `typeInEditor XXX` | 在编辑器输入文本 | `typeInEditor System.out.println()` |
| `typeAndTriggerSnippet XXX` | 输入并触发代码片段 | `typeAndTriggerSnippet class` |
| `navigateToError N` | 跳转到第 N 个错误 | `navigateToError 1` |
| `applyCodeAction XXX` | 执行 Code Action | `applyCodeAction Import 'ArrayList'` |
| `triggerCompletion` | 触发代码补全 | `triggerCompletion` |
| `insertLineInFile <path> <line> <text>` | 磁盘修改文件 + 编辑器重载 | `insertLineInFile src/Foo.java 2 import java.util.*;` |

### 支持的验证方式

| 字段 | 类型 | 说明 |
|------|------|------|
| `verify` | string | 自然语言描述预期结果（LLM 截图验证，需配置 Azure OpenAI） |
| `verifyFile` | object | 文件存在性 / 内容匹配 |
| `verifyNotification` | string | 通知消息匹配 |
| `verifyEditor` | object | 编辑器内容（检查 Monaco model + 可见 DOM） |
| `verifyProblems` | object | Problems 面板错误/警告计数（支持 `atLeast` 模式 + 轮询等待） |
| `verifyCompletion` | object | 代码补全列表验证 |
| `verifyTerminal` | object | 终端文本匹配，支持 `contains` / `notContains` |

---

## 测试隔离与截图

### 工作区隔离

每次运行自动将 `workspace` 复制到固定临时目录 (`autotest-workspace/`)，测试结束后清理。原始工作区**永远不会被修改**。

### 截图策略

每个步骤自动截图，保存到 `./screenshots/`（可通过 `--screenshots` 自定义）：

| 步骤状态 | 截图文件 |
|---------|---------|
| ✅ pass | `{stepId}_after.png` |
| ❌ fail / error | `{stepId}_before.png` + `{stepId}_after.png` 或 `{stepId}_error.png` |

### 进程管理

- 每次启动前自动清空 VSCode user-data 目录，防止旧窗口恢复
- Ctrl+C 中断时自动关闭 VSCode 进程
- `close()` 带重试机制处理 Windows 文件锁

---

## LLM 验证（可选）

`verify` 字段支持自然语言描述，框架会将截图发送给 Azure OpenAI GPT-4o 进行视觉判断：

```yaml
- id: "check-ls"
  action: "waitForLanguageServer"
  verify: "状态栏显示 Java 语言服务器已就绪（👍 图标）"   # ← LLM 看截图判断
  verifyProblems:                                        # ← 确定性验证照常执行
    errors: 0
```

配置环境变量启用：

```bash
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
export AZURE_OPENAI_API_KEY=<key>
export AZURE_OPENAI_DEPLOYMENT=gpt-4o        # 可选，默认 gpt-4o
```

- 未配置时 `verify` 字段自动跳过，确定性验证不受影响
- `--no-llm` 强制跳过 LLM 验证

---

## TreeView inline action 场景

VS Code 的 TreeView inline action（例如节点右侧的 Run / Add / New 图标）通常只在 hover、focus 或 selected 时显示。不要用固定坐标点击图标，使用 `clickTreeItemAction <item> <label>`：

```yaml
- action: "expandTreeItem Lifecycle"
- action: "clickTreeItemAction compile Run"
```

如果目标 view 被 Explorer、Outline、Timeline、Java Projects 等 section 挤到不可见，先折叠占空间的区域，再 focus 目标 view：

```yaml
- action: "collapseWorkspaceRoot"
- action: "collapseSidebarSection OUTLINE"
- action: "collapseSidebarSection TIMELINE"
- action: "run command Maven: Focus on Maven Projects View"
```

---

## Copilot CLI 集成

本项目提供 `AGENTS.md`，Copilot CLI 在此目录下可直接运行测试：

```
> 运行 java-maven 测试
```

Copilot CLI 会自动执行 `npx autotest run`，读取结果和截图，分析失败原因。

详见 [AGENTS.md](AGENTS.md)。

---

## 现有 Test Plan

| 文件 | 步数 | 来源 | 场景 | 状态 |
|------|------|------|------|------|
| `java-maven.yaml` | 8 | wiki Maven | LS → 补全 → 导航 → 编辑 → 诊断 | ✅ 8/8 |
| `java-maven-multimodule.yaml` | 5 | wiki Maven Multimodule | LS → 两模块补全 | ✅ 5/5 |
| `java-maven-java25.yaml` | 6 | wiki Maven Java 25 | JDK 25 → LS → 补全 → 编辑 | ✅ 6/6 |
| `java-gradle.yaml` | 7 | wiki Gradle | LS → 补全 → 导航 → 编辑 | ✅ 7/7 |
| `java-gradle-java25.yaml` | 6 | wiki Gradle Java 25 | JDK 25 → LS → 补全 → 编辑 | ✅ 6/6 |
| `java-basic-editing.yaml` | 8 | wiki Basic #1-5 | LS → class 骨架 → call() 方法 → 编译 | ✅ 8/8 |
| `java-basic-extended.yaml` | 8 | wiki Basic #6-8 | 补全 → Import → Rename | ✅ 8/8 |
| `java-new-file-snippet.yaml` | 4 | wiki Basic #9 | 创建新 Java 文件 → class 骨架 | ✅ 4/4 |
| `java-single-file.yaml` | 6 | wiki Single file | LS → 补全 → 编辑 | ✅ 6/6 |
| `java-debugger.yaml` | 6 | wiki Debugger | 断点 → 启动调试 → 停止 | ✅ 6/6 |
| `java-test-runner.yaml` | 6 | wiki Test Runner | 测试面板 → 运行全部 → CodeLens | ✅ 6/6 |
| `java-maven-resolve-type.yaml` | 10 | wiki Maven for Java | 未知类型 → Hover → Code Action | ✅ 10/10 |
| `java-dependency-viewer.yaml` | 4 | wiki Dependency Viewer | 依赖视图 → 节点展开 | ✅ 4/4 |
| `java-extension-pack.yaml` | 3 | wiki Extension Pack | Configure Classpath 命令 | ✅ 3/3 |
| `java-fresh-import.yaml` | 3 | wiki Fresh Import | Spring Petclinic → LS → 补全 | 🔲 需要 clone 项目 |

### Wiki 场景覆盖情况

| Wiki 场景 | 状态 | 阻碍 |
|-----------|------|------|
| Basic #1-5 | ✅ 已有 test plan | — |
| Basic #6-8 (补全/Import/Rename) | ✅ 已有 test plan | — |
| Basic #9 (New Java File snippet) | ✅ 已有 test plan | — |
| Maven | ✅ 已有 test plan | — |
| Maven Multimodule | ✅ 已有 test plan | — |
| Gradle | ✅ 已有 test plan | — |
| Maven Java 25 | ✅ 已有 test plan | — |
| Gradle Java 25 | ✅ 已有 test plan | — |
| Single file | ✅ 已有 test plan | — |
| Single file without workspace | ❌ 未覆盖 | 需要拖拽文件（无 Driver 支持） |
| Fresh import (spring-petclinic) | ✅ 已有 test plan | 需要提前 clone 项目 |
| Debugger for Java | ✅ 已有 test plan | — |
| Java Test Runner | ✅ 已有 test plan | — |
| Maven for Java | ✅ 已有 test plan | — |
| Java Dependency Viewer | ✅ 已有 test plan | — |
| Java Extension Pack | ✅ 已有 test plan | webview 内部交互有限 |

---

## 项目结构

```
autotest/
├── src/
│   ├── drivers/
│   │   └── vscodeDriver.ts    # Playwright VSCode 操作原语 (35+ 方法)
│   ├── operators/
│   │   ├── actionResolver.ts   # 自然语言 Action → Driver 调用 (16 种 regex)
│   │   ├── stepVerifier.ts     # 确定性验证 + LLM 验证 (6 种策略)
│   │   ├── llmClient.ts        # Azure OpenAI 客户端 (截图 → pass/fail)
│   │   ├── planParser.ts       # YAML Test Plan 解析器（路径相对于 plan 文件）
│   │   └── testRunner.ts       # 编排引擎（启动 → 执行 → 截图 → 报告）
│   ├── cli/
│   │   └── index.ts            # CLI 入口 (run / validate / --no-llm)
│   ├── types.ts                # 核心类型定义
│   └── index.ts                # SDK 导出
├── test-plans/                  # YAML 测试计划
├── test-results/                # 测试输出（每个 plan 一个子目录）
│   └── <plan-name>/
│       ├── results.json
│       └── screenshots/
├── AGENTS.md                    # Copilot CLI 集成指南
├── docs/
│   ├── architecture.md          # 架构文档
│   ├── implementation-plan.md   # 实现计划
│   └── ROADMAP.md               # 路线图
└── package.json
```

## 相关文档

- [架构设计](docs/architecture.md)
- [实现计划](docs/implementation-plan.md)
- [路线图](docs/ROADMAP.md)
