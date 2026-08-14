# DSH for VSC

把 DSH 的 WebUI（默认 http://127.0.0.1:3080/）映射为 VS Code 扩展页面：编辑器 Webview 面板 + 侧边栏控制台，并在服务离线时自动启动。

## 功能特性

- **侧边栏快捷入口**：Activity Bar 新增 DSH 鲸鱼图标，点击打开「DSH 控制台」侧边栏。
- **侧边栏状态与日志**：控制台实时显示服务在线/离线状态、服务地址，以及扩展运行日志（状态切换、面板操作、进程事件等）。
- **一键操作**：控制台内置「打开 WebUI / 刷新页面 / 浏览器 / 启动服务 / 停止服务」按钮，视图标题栏也有快捷图标。
- **自动启动服务**：检测到 DSH 服务离线约 6 秒后，自动以隐藏后台子进程方式启动（不占用终端；服务日志实时输出到「输出 → DSH Server」，VS Code 关闭时自动终止）；冷却 60 秒防止反复拉起。
- **嵌入面板**：在 VS Code 编辑区打开 DSH WebUI（iframe 方式嵌入，保留完整的页面交互能力）。
- **状态栏指示**：左下角常驻 DSH 图标，实时显示服务在线/离线状态，点击即可打开面板；离线时红色高亮。
- **状态保留**：面板切换到后台再切回时不会重新加载页面；重启 VS Code 后自动恢复面板。
- **可配置地址**：通过设置 dsh.webuiUrl 可指向任意 DSH 服务地址。

## 安装

### 方式一：直接安装 .vsix（推荐）

```bash
npm install
npm run compile
npm run package        # 生成 dsh-for-vsc-0.1.0.vsix
code --install-extension dsh-for-vsc-0.1.0.vsix
```

### 方式二：F5 调试运行

1. 用 VS Code 打开本目录；
2. 按 F5（已配置 .vscode/launch.json，会自动编译并启动扩展开发宿主窗口）；
3. 点击左侧 Activity Bar 的鲸鱼图标打开「DSH 控制台」，或执行命令 **DSH: Open WebUI**。

## 使用

| 操作 | 方式 |
| --- | --- |
| 打开侧边栏控制台 | 点击 Activity Bar 的鲸鱼图标（DSH 控制台） |
| 打开 WebUI 面板 | 命令 DSH: Open WebUI、状态栏 DSH 图标或控制台按钮 |
| 重新加载 | 命令 DSH: Reload WebUI 或控制台「刷新页面」 |
| 浏览器打开 | 命令 DSH: Open in Browser 或控制台「浏览器」 |
| 启动/停止服务 | 命令 DSH: Start Server / Stop Server，或控制台按钮 |

## 配置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| dsh.webuiUrl | http://127.0.0.1:3080/ | DSH WebUI 服务地址 |
| dsh.autoStart | true | 服务离线时自动以 VS Code 后台任务启动 |
| dsh.startCommand | （自动检测） | 启动命令，留空自动检测：PATH 有 dsh 用 `dsh web`，否则用 `npx @deepseek-ai/dsh web`；示例: dsh --profile web --port 3080 |

## 工作原理

- 扩展激活后常驻连通性探测（Node http.get，2 秒间隔）；状态变化时更新状态栏、侧边栏并重渲染面板。
- 服务离线约 6 秒后触发自动启动：扩展宿主内 spawn 隐藏后台子进程执行启动命令（默认自动检测：`dsh web` 或回退 `npx @deepseek-ai/dsh web`），stdin 关闭、stdout/stderr 经管道持续消费并写入「输出 → DSH Server」通道；进程退出事件会被记录。
- 面板/控制台 HTML 使用严格 CSP：default-src 'none'，iframe 的 frame-src 仅指向 DSH 服务地址。
- 已验证 DSH 服务响应头不包含 X-Frame-Options / frame-ancestors，可安全嵌入。

## 开发调试

```bash
npm run compile   # 编译 TypeScript
npm run watch     # 增量编译
```

## License

MIT