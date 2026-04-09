# VSCode AutoTest — AI 驱动的 VSCode 扩展测试框架

## 1. 项目定位

一个 **AI 驱动的 VSCode 扩展 E2E 测试工具**。  
用户只需提供结构化的 Test Plan（YAML），框架自动启动 VSCode、执行操作、验证结果。  
核心理念：**不写死测试脚本，而是让 AI 根据 Snapshot 动态决策。**

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
│                   AI Test Runner                         │
│  读取 Plan → 逐步解释 → 决策下一步操作 → 验证结果       │
│  循环: snapshot → 决策 → 执行 → snapshot → 验证          │
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
| 🟠 3 | AI 读 Snapshot 动态决策 | 灵活 | AI 看到 `[button "Submit"]` 自己找 | 插件自定义 UI、未知界面 |

**设计原则：优先用命令绕过 UI → 其次用 A11y Role → 最后让 AI 看 snapshot 自己判断。**

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

### 4.3 AI 动态操作（基于 Snapshot）

当上面两种方式不够用时，AI 读取 Accessibility 快照自行决策：

```typescript
// 获取当前 UI 的结构化描述（A11y 树）
async snapshot(): Promise<A11yTree>

// 获取 DOM 快照（用于更底层的分析）
async domSnapshot(): Promise<string>

// 截图（视觉验证）
async screenshot(path?: string): Promise<Buffer>

// 通用点击（AI 根据 snapshot 决定 locator）
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
| `verifyCommand` | 验证某个命令执行后的返回值 |
| `timeout` | 单步超时（秒） |
| `waitBefore` | 执行前等待时间（秒） |

### 5.3 Test Plan 可迭代更新

- 每次执行后，框架输出详细的执行日志和 snapshot
- 如果某一步失败，AI 可以建议如何修改 test plan
- 新增测试步骤只需追加 YAML，不需要改代码

---

## 6. AI Test Runner 执行流程

```
┌─────────────────────────────────────────────────┐
│            AI Test Runner 主循环                 │
│                                                  │
│  for each step in testPlan.steps:                │
│    │                                             │
│    ├─ 1. snapshot = driver.snapshot()             │
│    │     拍当前 UI 状态的 A11y 快照              │
│    │                                             │
│    ├─ 2. actions = AI.plan(step.action, snapshot) │
│    │     AI 根据步骤描述 + 当前 UI 状态          │
│    │     决定调用哪些 Driver 原语                │
│    │                                             │
│    ├─ 3. for each action in actions:              │
│    │       driver.execute(action)                 │
│    │     执行 AI 规划的操作序列                   │
│    │                                             │
│    ├─ 4. snapshot = driver.snapshot()             │
│    │     再次拍快照                               │
│    │                                             │
│    ├─ 5. result = AI.verify(step.verify, snapshot)│
│    │     AI 对比 snapshot 与预期结果              │
│    │                                             │
│    ├─ 6. 如果有 verifyFile / verifyNotification:  │
│    │     执行确定性验证（非 AI）                  │
│    │                                             │
│    └─ 7. 记录结果: pass / fail / reason           │
│                                                  │
│  输出: TestReport                                │
└─────────────────────────────────────────────────┘
```

### 6.1 确定性验证 vs AI 验证

| 验证方式 | 何时使用 | 优点 | 缺点 |
|----------|---------|------|------|
| **确定性验证** (`verifyFile`, `verifyNotification`) | 有明确的、可程序化检查的预期 | 100% 可靠、可重复 | 需要精确匹配条件 |
| **AI 验证** (`verify`: 自然语言) | UI 状态、模糊匹配、视觉判断 | 灵活、不需要精确 locator | 有一定误判概率 |

**建议：能用确定性验证的，尽量用确定性验证。AI 验证用于补充。**

---

## 7. 与 OpenCLI 的对比

| 方面 | OpenCLI Adapter 模式 | 本项目（独立方案） |
|------|---------------------|------------------|
| 浏览器引擎 | CDP 直连 (IPage 封装) | Playwright Electron (Page 原生) |
| VSCode 操作能力 | IPage 较弱（无 getByRole、无自动等待） | Playwright Page 完整能力 |
| 目标应用 | 通用（几十个 App 适配） | 专注 VSCode |
| 输出格式 | table/json/yaml（面向人） | 结构化 JSON（面向 AI） |
| 使用方式 | CLI 命令 (`opencli vscode command ...`) | SDK + CLI 双模式 |
| AI 集成 | 无内置 AI 层 | 内置 AI snapshot → 决策 → 验证 循环 |
| 测试驱动方式 | 需要手动编排命令 | Test Plan 声明式驱动 |

---

## 8. 技术选型

| 组件 | 技术 | 理由 |
|------|------|------|
| VSCode 启动/控制 | `@playwright/test` + `@vscode/test-electron` | 官方推荐方案，Electron 原生支持 |
| CLI 入口 | `commander` | 轻量、成熟 |
| Test Plan 解析 | `js-yaml` | YAML 解析 |
| AI 集成 | Copilot CLI / OpenAI API | 理解 action、分析 snapshot、验证结果 |
| 报告输出 | 自定义 JSON + console | 结构化 + 人类可读 |
| 类型系统 | TypeScript | 类型安全 |

---

## 9. 风险与应对

| 风险 | 应对 |
|------|------|
| VSCode UI 更新导致 A11y 树变化 | 优先用 Command ID；A11y Role 比 CSS 稳定得多 |
| AI 理解 action 出错 | 提供"操作词典"，将自然语言映射到确定性原语 |
| AI 验证误判 | 关键验证用确定性方式（verifyFile 等），AI 验证仅做补充 |
| Electron 启动慢 | 支持复用已启动的 VSCode 实例（通过 CDP 端口连接） |
| 插件加载延迟 | setup 阶段等待插件 activate，可配置超时 |
