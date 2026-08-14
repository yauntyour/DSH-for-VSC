# DSH for VSC

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）的 WebUI 搬进 VS Code：编辑器内嵌面板 + 侧边栏控制台，服务离线自动拉起，日志随时可查。

DSH for VSC 是一个 VS Code 扩展，将 DSH 的 Web 界面（默认 `http://127.0.0.1:3080/`）映射为 VS Code 的扩展页面，让你在 IDE 内完成"看状态 → 开面板 → 用 WebUI → 看日志"的完整闭环，无需在浏览器和编辑器之间切换。

## 功能特性

- **侧边栏快捷入口**：Activity Bar 新增 DSH 鲸鱼图标，一键打开「DSH 控制台」。
- **侧边栏控制台**：实时显示服务在线/离线状态与服务地址；内置「打开 WebUI / 刷新页面 / 浏览器 / 启动服务 / 停止服务」按钮。
- **侧边栏配置**：自动启动开关、启动命令均可直接在控制台内修改并即时生效（写入 VS Code 全局设置）。
- **侧边栏运行日志**：滚动记录扩展运行事件（状态切换、面板操作、进程启停、配置变更），同时写入输出通道。
- **编辑器内嵌面板**：Webview 全屏加载 DSH WebUI，保留完整页面交互；切换后台不重载，重启 VS Code 自动恢复。
- **状态栏指示**：左下角常驻 DSH 图标，在线/离线一目了然（离线红色高亮），点击即开面板。
- **服务自动启动**：检测到服务离线约 6 秒后，自动以**隐藏后台子进程**方式拉起 DSH（不占用终端）；60 秒冷却防止反复拉起。
- **服务日志**：服务进程的 stdout/stderr 经管道实时输出到「输出 → DSH Server」，不占终端、随时可查。
- **可配置地址**：通过 `dsh.webuiUrl` 可指向任意 DSH 服务（含远程主机）。

## 环境要求

- VS Code `^1.85.0`（Windows / macOS / Linux）
- Node.js（扩展宿主自带；**启动 DSH 服务时需要**）
- DSH CLI：`dsh` 在 PATH 中，或可通过 `npx @deepseek-ai/dsh` 运行（二选一，见[自动检测](#自动检测)）

## 安装

### 方式一：安装 .vsix（推荐）

```bash
npm install
npm run compile
npm run package          # 生成 dsh-for-vsc-0.1.0.vsix
code --install-extension dsh-for-vsc-0.1.0.vsix
```

安装后重载窗口，左侧 Activity Bar 即出现 DSH 鲸鱼图标。

### 方式二：F5 调试运行

1. 用 VS Code 打开本仓库目录；
2. 按 `F5`（`.vscode/launch.json` 已配置，自动编译并启动扩展开发宿主窗口）；
3. 在开发宿主窗口中点击鲸鱼图标或执行命令 **DSH: Open WebUI**。

## 快速开始

1. 安装扩展并重载窗口；
2. 若 DSH 服务未启动，等待约 6 秒——扩展会自动在后台拉起服务（也可点控制台「启动服务」立即拉起）；
3. 点击 Activity Bar 的鲸鱼图标打开「DSH 控制台」，确认状态为绿色「在线」；
4. 点击「打开 WebUI」，DSH 界面即在编辑区呈现。

## 使用指南

### 命令

| 命令 | 说明 |
| --- | --- |
| `DSH: Open WebUI` | 打开（或聚焦）WebUI 内嵌面板 |
| `DSH: Reload WebUI` | 关闭并重新打开面板（强制刷新页面） |
| `DSH: Open in Browser` | 在系统浏览器中打开 DSH 页面 |
| `DSH: Start Server` | 手动启动 DSH 服务（后台子进程） |
| `DSH: Stop Server` | 停止由本扩展启动的服务进程 |

### 侧边栏「DSH 控制台」

| 区域 | 内容 |
| --- | --- |
| 状态区 | 在线/离线圆点、服务地址 |
| 操作区 | 打开 WebUI / 刷新页面 / 浏览器 / 启动服务 / 停止服务 |
| 设置区 | 「离线时自动启动服务」开关、启动命令输入框（留空自动检测，回车或点「保存」生效） |
| 运行日志 | 扩展运行事件滚动列表（最新在前，最多保留 150 条） |

### 服务管理

- **启动**：服务离线约 6 秒后自动拉起；或点击「启动服务」/ 执行 `DSH: Start Server`。
- **停止**：点击「停止服务」/ 执行 `DSH: Stop Server`；VS Code 关闭时扩展会自动终止其拉起的服务进程，不留孤儿进程。
- **日志**：服务进程输出实时写入「输出 → DSH Server」通道；扩展自身事件写入「输出 → DSH for VSC」通道。

## 配置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dsh.webuiUrl` | `http://127.0.0.1:3080/` | DSH WebUI 服务地址（Webview 面板与控制台状态均基于此） |
| `dsh.autoStart` | `true` | 服务离线时是否自动启动 |
| `dsh.startCommand` | 空（自动检测） | 启动 DSH 服务的完整命令；留空自动检测（见下） |

### 自动检测

`dsh.startCommand` 留空时，扩展按以下顺序选择启动命令：

1. 检测扩展宿主 PATH 中是否存在 `dsh` → 使用 `dsh web`；
2. 否则回退为 `npx @deepseek-ai/dsh web`。

自定义示例：`dsh --profile web --port 3080`、`node C:/path/to/dsh/lib/bin.js web` 等。

## 工作原理

```text
┌──────────────────────────── VS Code ────────────────────────────┐
│  Activity Bar(鲸鱼) ──> DSH 控制台 (WebviewView)                │
│        │ 状态推送/日志推送/配置读写 (postMessage)                │
│        ▼                                                         │
│  扩展宿主 (extension host)                                       │
│   ├─ 状态机：每 2s http.get 探测服务连通性                      │
│   │    └─ 离线连续 3 次(≈6s) 且 autoStart=on ──> spawn 启动     │
│   ├─ 服务进程：childProcess.spawn(隐藏, 管道 stdio)             │
│   │    └─ stdout/stderr ──> 输出通道 DSH Server                 │
│   ├─ WebUI 面板：Webview + iframe(frame-src 仅指向 WebUI 地址)  │
│   └─ 状态栏：DSH 图标（离线红色高亮）                            │
└─────────────────────────────────────────────────────────────────┘
        │                                ▲
        ▼                                │ 连通性探测 / 页面加载
┌─────────────────────────────────────────────────────────────────┐
│  DSH 服务 (dsh web, 默认 127.0.0.1:3080)                        │
└─────────────────────────────────────────────────────────────────┘
```

- **连通性探测**：扩展激活后常驻轮询（2 秒间隔，1.5 秒超时），状态变化时同步刷新状态栏、侧边栏与面板，并写入日志。
- **自动启动**：连续离线 3 次探测后触发；启动采用 `spawn(command, { shell: true, windowsHide: true, stdio: ['ignore','pipe','pipe'] })`，stdin 关闭、输出经管道持续消费（避免子进程因管道缓冲写满而阻塞），转存到「DSH Server」输出通道。
- **进程生命周期**：`exit` / `error` 事件驱动状态重置与日志记录；`deactivate` 时终止服务进程。
- **安全嵌入**：面板与控制台 HTML 使用严格 CSP（`default-src 'none'`），iframe 的 `frame-src` 仅允许 DSH 服务地址；已验证 DSH 服务响应头不含 `X-Frame-Options` / `frame-ancestors`，可安全内嵌。
- **会话恢复**：`retainContextWhenHidden` 保留面板状态；`registerWebviewPanelSerializer` 在窗口重启后恢复面板。

## 目录结构

```text
DSH for VSC/
├── src/extension.ts        # 扩展唯一入口：面板/控制台/状态机/进程管理
├── media/deepseek-whale.svg  # Activity Bar 鲸鱼图标（单色，自适应主题）
├── out/                    # 编译产物（extension.js）
├── package.json            # 清单：命令/视图/配置/激活事件
├── tsconfig.json           # TypeScript 编译配置
├── .vscode/                # launch.json / tasks.json（F5 调试）
├── .vscodeignore           # vsix 打包排除规则
├── README.md
└── LICENSE                 # MIT
```

## 开发

```bash
npm install        # 安装依赖（typescript / @types/vscode / vsce）
npm run compile    # 编译 TypeScript → out/
npm run watch      # 增量编译（开发时配合 F5 使用）
npm run package    # 打包 .vsix（vsce --no-dependencies）
```

## 常见问题

### 服务启动失败，日志提示找不到可用命令

扩展会在侧边栏与输出通道打印实际尝试的命令。若 `dsh` 与 `npx` 均不可用，请在设置 `dsh.startCommand` 中填入实际启动命令（例如用 Node 直接指向 DSH 的 `lib/bin.js`）。

### 自动启动没有生效

检查控制台设置区「离线时自动启动服务」开关是否打开（对应 `dsh.autoStart`）；另外自动启动有 60 秒冷却期，手动停止后需等待冷却结束。

### 服务日志在哪里看

「查看 → 输出」→ 下拉选择 **DSH Server**（服务进程输出）或 **DSH for VSC**（扩展事件日志）。

### VS Code 关闭后服务会怎样

由扩展拉起的服务进程会随 VS Code 关闭被终止（`deactivate` 时 kill）。如需常驻服务，请在外部终端自行启动 `dsh web`，扩展会自动探测并接入。

### 端口冲突

若 3080 端口被其他进程占用，请通过 `dsh.webuiUrl` 与 `dsh.startCommand` 分别配置实际地址与端口（如 `dsh --profile web --port 3090`）。

## License

MIT
