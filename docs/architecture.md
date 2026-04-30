# VSCode AutoTest — AI 驱动的 VSCode 扩展测试框架

## 1. 项目定位

一个 **AI 驱动的 VSCode 扩展 E2E 测试工具**。  
用户只需提供结构化的 Test Plan（YAML），框架自动启动 VSCode、执行操作、验证结果。  
核心理念：**用声明式 Test Plan 驱动稳定的 VSCode 操作原语，优先确定性执行和验证，AI 仅作为失败截图分析的辅助层。**

---

## 2. 核心架构

```
┌──────────────────────────────────────────────────────────┐
│                      Test Plan (YAML)                    │
│  人工编写：描述测试步骤 + 预期结果，不包含 locator       │
└──────────────────┬───────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────┐
│                    TestRunner                            │
│  读取 Plan → ActionResolver → Driver → StepVerifier      │
│  执行前/后截图 → results.json / summary.md → LLM 失败分析 │
└──────────────────┬───────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────┐
│              VscodeDriver (操作原语 SDK)                  │
│  基于 Playwright + @vscode/test-electron                 │
│  提供稳定的 VSCode 操作接口                              │
└──────────────────┬───────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────┐
│              Playwright Electron Runtime                  │
│  启动 VSCode Electron 进程，提供 Page 对象               │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Locator 稳定性三级策略

框架不依赖脆弱的 CSS selector，而是按优先级使用三种定位方式：

| 优先级 | 方式 | 稳定度 | 示例 | 适用场景 |
|--------|------|--------|------|---------|
| 🟢 1 | VSCode Command ID | 极高 | `editor.action.formatDocument` | 所有有命令的操作 |
| 🟡 2 | Accessibility Role + Name | 高 | `getByRole('treeitem', {name: 'API Center'})` | TreeView、Tab、按钮等 |
| 🟠 3 | 截图 / A11y Snapshot 辅助分析 | 灵活 | 失败后对比 before/after 截图 | 插件自定义 UI、未知界面 |

**设计原则：优先用命令绕过 UI → 其次用 A11y Role → 最后用截图和 snapshot 辅助定位失败原因。**

---

## 4. VscodeDriver 操作原语设计

### 4.1 极稳定操作（基于 VSCode 命令/快捷键系统）

这些操作依赖 VSCode 的命令体系或快捷键，跨版本极少变化：

```typescript
// 执行 VSCode 命令（最核心的原语）
async runCommand(commandId: string, ...args: any[]): Promise<void>

// 通过 Command Palette 执行命令（当不知道 commandId 时）
async runCommandFromPalette(label: string): Promise<void>

// 文件操作（通过命令系统）
async openFile(filePath: string): Promise<void>
async getEditorContent(): Promise<string>
async setEditorContent(content: string): Promise<void>
async saveFile(): Promise<void>

// 终端操作
async runInTerminal(command: string): Promise<string>

// 快捷键
async pressKeys(keys: string): Promise<void>
```

### 4.2 较稳定操作（基于 Accessibility Role）

基于 Playwright 的 `getByRole` API，比 CSS 选择器稳定得多：

```typescript
// 侧边栏
async activeSideTab(tabName: string): Promise<void>
async isSideTabVisible(tabName: string): Promise<boolean>

// TreeView
async clickTreeItem(name: string): Promise<void>
async expandTreeItem(name: string): Promise<void>
async isTreeItemVisible(name: string): Promise<boolean>

// Command Palette 交互
async selectPaletteOption(optionText: string): Promise<void>
async selectPaletteOptionByIndex(index: number): Promise<void>

// 通知
async getNotifications(): Promise<string[]>
async dismissNotification(text: string): Promise<void>

// 状态栏
async getStatusBarText(): Promise<string>
```

### 4.3 Snapshot 与通用 UI 原语

当上面两种方式不够用时，Driver 仍提供截图、Accessibility 快照和通用定位原语，供调试、失败分析或后续扩展使用：

```typescript
// 获取当前 UI 的结构化描述（A11y 树）
async snapshot(): Promise<A11yTree>

// 获取 DOM 快照（用于更底层的分析）
async domSnapshot(): Promise<string>

// 截图（视觉验证）
async screenshot(path?: string): Promise<Buffer>

// 通用点击
async clickByRole(role: string, name: string): Promise<void>
async clickByText(text: string): Promise<void>
```

### 4.4 验证操作

```typescript
// UI 状态验证
async isElementVisible(role: string, name: string): Promise<boolean>
async getElementText(role: string, name: string): Promise<string>

// 编辑器验证
async editorContains(text: string): Promise<boolean>
async getEditorLanguage(): Promise<string>
async getEditorFileName(): Promise<string>

// Problems 面板
async getProblems(): Promise<Diagnostic[]>
async getProblemCount(): Promise<{ errors: number; warnings: number }>

// 文件系统验证
async fileExists(path: string): Promise<boolean>
async fileContains(path: string, text: string): Promise<boolean>
async readFile(path: string): Promise<string>
```

---

## 5. Test Plan 格式设计

### 5.1 YAML 格式

```yaml
name: "验证 API Center 树视图导航"
description: "测试 Azure API Center 扩展的树视图功能"

setup:
  extension: "azure-api-center"
  extensionPath: "./path/to/extension"    # 扩展开发路径
  vscodeVersion: "insiders"               # stable | insiders
  workspace: "./test-workspace"           # 工作区目录
  settings:                               # VSCode settings.json 预填
    azure-api-center.tenant:
      name: "test-tenant"
      id: "xxx-xxx"
  timeout: 120                            # 全局超时（秒）

steps:
  - id: "open-side-panel"
    action: "点击侧边栏 API Center tab"
    verify: "API Center 面板可见"

  - id: "expand-subscription"
    action: "展开 Azure Subscription 节点"
    verify: "能看到 apic-test service"

  - id: "register-api"
    action: "执行命令 Azure API Center: Register API"
    verify: "弹出 CI/CD 选项列表"

  - id: "select-github"
    action: "选择 GitHub 选项"
    verify: "生成 register-api.yml 文件"
    verifyFile:
      path: ".github/workflows/register-api.yml"
      contains: "azure/api-center"

  - id: "check-notification"
    action: "等待操作完成"
    verifyNotification: "API registered successfully"
```

### 5.2 Test Plan 字段说明

| 字段 | 说明 |
|------|------|
| `action` | 自然语言描述要执行的操作，AI 解释后映射到 Driver 原语 |
| `verify` | 自然语言描述预期结果，AI 通过 snapshot 验证 |
| `verifyFile` | 文件系统级别验证（路径 + 内容匹配） |
| `verifyNotification` | 验证特定通知出现 |
| `verifyEditor` | 验证编辑器内容 |
| `verifyProblems` | 验证 Problems 错误/警告计数 |
| `verifyCompletion` | 验证补全列表 |
| `verifyQuickInput` | 验证 Quick Input 校验消息 |
| `verifyDialog` | 验证 modal dialog 可见性和内容 |
| `verifyTreeItem` | 验证 TreeView 节点出现或消失 |
| `verifyEditorTab` | 验证 editor tab 标题 |
| `verifyOutputChannel` | 验证 Output channel 文本 |
| `verifyTerminal` | 验证 Terminal 文本 |
| `timeout` | 单步超时（秒） |
| `waitBefore` | 执行前等待时间（秒） |

### 5.3 Test Plan 可迭代更新

- 每次执行后，框架输出详细的执行日志、截图和 JSON 报告
- 如果某一步失败，已配置 Azure OpenAI 时会基于 before/after 截图建议如何修改 test plan
- 新增测试步骤只需追加 YAML，不需要改代码

---

## 6. TestRunner 执行流程

```
┌─────────────────────────────────────────────────┐
│              TestRunner 主循环                   │
│                                                  │
│  for each step in testPlan.steps:                │
│    │                                             │
│    ├─ 1. waitBefore（可选）                       │
│    │                                             │
│    ├─ 2. before screenshot                        │
│    │                                             │
│    ├─ 3. ActionResolver.resolve(step.action)      │
│    │     regex 字典匹配 Driver 原语；未匹配时     │
│    │     回退为 Command Palette 文本              │
│    │                                             │
│    ├─ 4. after screenshot                         │
│    │                                             │
│    ├─ 5. StepVerifier.verify(step)                │
│    │     执行所有确定性验证                       │
│    │                                             │
│    ├─ 6. 若失败且 LLM 已配置：                    │
│    │     对比 before/after 截图并生成建议         │
│    │                                             │
│    └─ 7. 记录结果: pass / fail / reason           │
│                                                  │
│  输出: TestReport                                │
└─────────────────────────────────────────────────┘
```

### 6.1 确定性验证 vs AI 验证

| 验证方式 | 何时使用 | 优点 | 缺点 |
|----------|---------|------|------|
| **确定性验证** (`verifyFile`, `verifyProblems`, `verifyTerminal` 等) | 有明确的、可程序化检查的预期 | 100% 可靠、可重复 | 需要精确匹配条件 |
| **AI 失败分析** (`verify`: 自然语言上下文 + 截图) | 步骤失败后解释 UI 变化和可能原因 | 灵活、能给修复建议 | 不决定 pass/fail，有一定误判概率 |

**建议：能用确定性验证的，尽量用确定性验证。AI 用于失败诊断和改进 test plan。**

---

## 7. 与 OpenCLI 的对比

| 方面 | OpenCLI Adapter 模式 | 本项目（独立方案） |
|------|---------------------|------------------|
| 浏览器引擎 | CDP 直连 (IPage 封装) | Playwright Electron (Page 原生) |
| VSCode 操作能力 | IPage 较弱（无 getByRole、无自动等待） | Playwright Page 完整能力 |
| 目标应用 | 通用（几十个 App 适配） | 专注 VSCode |
| 输出格式 | table/json/yaml（面向人） | 结构化 JSON（面向 AI） |
| 使用方式 | CLI 命令 (`opencli vscode command ...`) | SDK + CLI 双模式 |
| AI 集成 | 无内置 AI 层 | 可选 Azure OpenAI 失败截图分析 |
| 测试驱动方式 | 需要手动编排命令 | Test Plan 声明式驱动 |

---

## 8. 技术选型

| 组件 | 技术 | 理由 |
|------|------|------|
| VSCode 启动/控制 | `@playwright/test` + `@vscode/test-electron` | 官方推荐方案，Electron 原生支持 |
| CLI 入口 | `commander` | 轻量、成熟 |
| Test Plan 解析 | `js-yaml` | YAML 解析 |
| AI 集成 | Copilot CLI / Azure OpenAI API | 运行编排、失败截图分析、修复建议 |
| 报告输出 | 自定义 JSON + console | 结构化 + 人类可读 |
| 类型系统 | TypeScript | 类型安全 |

---

## 9. 风险与应对

| 风险 | 应对 |
|------|------|
| VSCode UI 更新导致 A11y 树变化 | 优先用 Command ID；A11y Role 比 CSS 稳定得多 |
| action 映射出错 | 提供 regex 操作词典；未匹配时回退到 Command Palette |
| AI 分析误判 | pass/fail 只由确定性验证决定，AI 仅做失败分析 |
| Electron 启动慢 | 复用临时 user-data / extensions 目录并控制进程生命周期；attach 模式为后续扩展点 |
| 插件加载延迟 | setup 阶段等待插件 activate，可配置超时 |
