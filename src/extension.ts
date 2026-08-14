// DSH for VSC —— 把 DSH WebUI 映射为 VS Code 扩展页面：
//  - 编辑器 Webview 面板承载 WebUI
//  - 侧边栏 (Activity Bar) 提供快捷入口、服务状态与运行日志
//  - 服务离线时自动以 VS Code 后台任务方式启动 (dsh web)
import * as vscode from 'vscode';
import * as http from 'http';
import * as os from 'os';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const VIEW_TYPE = 'dsh.webui';
const VIEW_TITLE = 'DSH WebUI';
const DASHBOARD_VIEW_ID = 'dsh.dashboard';
const DEFAULT_URL = 'http://127.0.0.1:3080/';
const DEFAULT_START_COMMAND = 'dsh web';
const POLL_INTERVAL_MS = 2000; // 服务连通性轮询间隔
const REQUEST_TIMEOUT_MS = 1500; // 连通性探测超时
const AUTO_START_STREAK = 3; // 连续离线探测次数(≈6s)后触发自动启动
const START_COOLDOWN_MS = 60_000; // 两次自动启动的最小间隔，防止反复拉起
const MAX_LOG_ENTRIES = 300;

interface LogEntry {
  time: string;
  text: string;
  level: 'info' | 'warn' | 'error';
}

let panel: vscode.WebviewPanel | undefined;
let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let pollTimer: NodeJS.Timeout | undefined;
let online = false;
let offlineStreak = 0;
let lastStartAttempt = 0;
let serverProcess: childProcess.ChildProcess | undefined;
let serverOutput: vscode.OutputChannel;
// 本扩展拉起的服务进程 PID 的持久化位置与记录（跨 VS Code 会话，用于清理遗留/孤儿进程）
let pidFile: string | undefined;
let trackedPid: number | undefined;
let dashboard: vscode.WebviewView | undefined;
const logEntries: LogEntry[] = [];

export function activate(context: vscode.ExtensionContext): void {
  // 输出通道（View → Output → "DSH for VSC"）
  output = vscode.window.createOutputChannel('DSH for VSC');
  context.subscriptions.push(output);
  // DSH 服务进程的输出通道（不占用终端，服务日志在这里查看）
  serverOutput = vscode.window.createOutputChannel('DSH Server');
  context.subscriptions.push(serverOutput);

  // 状态栏入口（点击打开面板）
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'dsh.open';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // 侧边栏控制台（Activity Bar → DSH 鲸鱼图标）
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DASHBOARD_VIEW_ID,
      new DshDashboardProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.open', () => openPanel(context)),
    vscode.commands.registerCommand('dsh.reload', () => {
      if (panel) {
        panel.dispose();
      }
      openPanel(context);
    }),
    vscode.commands.registerCommand('dsh.openExternal', () => {
      void vscode.env.openExternal(vscode.Uri.parse(getWebuiUrl()));
    }),
    vscode.commands.registerCommand('dsh.startServer', () => startServer('手动')),
    vscode.commands.registerCommand('dsh.stopServer', () => stopServer()),
    // 配置变更时立即生效
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dsh')) {
        if (e.affectsConfiguration('dsh.webuiUrl')) {
          log(`WebUI 地址变更为: ${getWebuiUrl()}`);
        }
        refreshStatusBar();
        renderPanel();
        pushStatus();
        schedulePoll(0);
      }
    }),
  );

  // VS Code 窗口重启后恢复已打开的面板
  if (typeof vscode.window.registerWebviewPanelSerializer === 'function') {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel): Promise<void> {
          panel = webviewPanel;
          // 面板级选项(retainContextWhenHidden 等)在序列化时自动保留，这里只需恢复 webview 脚本能力
          webviewPanel.webview.options = { enableScripts: true };
          setupPanel(webviewPanel, context);
        },
      }),
    );
  }

  // 接管先前会话遗留的服务进程（PID 记录在 globalStorage，用于关闭时清理孤儿进程）
  pidFile = vscode.Uri.joinPath(context.globalStorageUri, 'server.pid').fsPath;
  loadTrackedPid();

  log('扩展已激活');
  refreshStatusBar();
  schedulePoll(0);
}

export function deactivate(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  // VS Code 关闭时终止由本扩展拉起的整个服务进程树（shell 及其所有子进程），
  // 避免仅杀掉外层 shell 而遗留真正的 DSH 服务进程
  const pid = serverProcess?.pid ?? trackedPid;
  killServerTree(pid);
  serverProcess = undefined;
  trackedPid = undefined;
  clearPid();
}

// ---------------------------------------------------------------- 日志中心

function log(text: string, level: LogEntry['level'] = 'info'): void {
  const entry: LogEntry = {
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    text,
    level,
  };
  logEntries.push(entry);
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.shift();
  }
  output.appendLine(`[${entry.time}] ${text}`);
  dashboard?.webview.postMessage({ type: 'log', entry });
}

function pushStatus(): void {
  dashboard?.webview.postMessage({
    type: 'status',
    online,
    url: getWebuiUrl(),
    running: serverProcess !== undefined || (trackedPid !== undefined && isProcessAlive(trackedPid)),
    autoStart: getAutoStart(),
    startCommand: getStartCommandSetting(),
  });
}

function getAutoStart(): boolean {
  return vscode.workspace.getConfiguration('dsh').get<boolean>('autoStart', true);
}

// 用户配置的启动命令原文（空 = 自动检测）
function getStartCommandSetting(): string {
  const cmd = vscode.workspace.getConfiguration('dsh').get<string>('startCommand', '');
  return (cmd ?? '').trim();
}

// ------------------------------------------- 服务进程生命周期管理

// 进程是否存活（signal 0 仅探测不发送信号；Windows 上同样安全）
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 从持久化记录中接管上一会话遗留的服务进程
function loadTrackedPid(): void {
  if (!pidFile) {
    return;
  }
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      trackedPid = pid;
      log(`检测到先前会话遗留的 DSH 服务进程 (PID ${pid})，本扩展将继续管理它`, 'warn');
    } else {
      clearPid(); // 记录已过期
    }
  } catch {
    // 无 PID 记录属正常情况
  }
}

function savePid(pid: number): void {
  if (!pidFile) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(pid), 'utf8');
  } catch {
    /* 忽略 */
  }
}

function clearPid(): void {
  if (!pidFile) {
    return;
  }
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {
    /* 忽略 */
  }
}

// 终止整个进程树：
//  - Windows: taskkill /T 连子孙进程一并结束（spawn(shell:true) 时 kill() 只能杀掉外层 cmd）
//  - POSIX:   进程以独立进程组启动（detached），向组内广播 SIGTERM
function killServerTree(pid: number | undefined): boolean {
  if (!pid || !isProcessAlive(pid)) {
    return false;
  }
  try {
    if (process.platform === 'win32') {
      childProcess.execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGTERM'); // 进程组
      } catch {
        process.kill(pid, 'SIGTERM'); // 无独立进程组时退化为单进程
      }
    }
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 忽略 */
    }
    return false;
  }
}

// ---------------------------------------------------------- 侧边栏控制台

class DshDashboardProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    dashboard = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getDashboardHtml();
    webviewView.webview.onDidReceiveMessage(
      (msg: unknown) => {
        const m = msg as { type?: string };
        switch (m?.type) {
          case 'openPanel':
            openPanel(this.context);
            break;
          case 'reload':
            if (panel) {
              panel.dispose();
            }
            openPanel(this.context);
            break;
          case 'openExternal':
            void vscode.env.openExternal(vscode.Uri.parse(getWebuiUrl()));
            break;
          case 'startServer':
            startServer('侧边栏');
            break;
          case 'stopServer':
            stopServer();
            break;
          case 'retry':
            online = false;
            renderPanel();
            schedulePoll(0);
            break;
          case 'setAutoStart': {
            const v = (msg as { value?: boolean }).value;
            void vscode.workspace
              .getConfiguration('dsh')
              .update('autoStart', v, vscode.ConfigurationTarget.Global)
              .then(
                () => log(`自动启动已${v ? '开启' : '关闭'}`),
                (err: unknown) => log(`保存自动启动设置失败: ${String(err)}`, 'error'),
              );
            break;
          }
          case 'setStartCommand': {
            const v = (((msg as { value?: string }).value) ?? '').trim();
            void vscode.workspace
              .getConfiguration('dsh')
              .update('startCommand', v, vscode.ConfigurationTarget.Global)
              .then(
                () => log(v ? `启动命令已保存: ${v}` : '启动命令已清空（将自动检测）'),
                (err: unknown) => log(`保存启动命令失败: ${String(err)}`, 'error'),
              );
            break;
          }
        }
      },
      undefined,
      this.context.subscriptions,
    );
    webviewView.onDidDispose(() => {
      if (dashboard === webviewView) {
        dashboard = undefined;
      }
    });
    // 视图就绪后推送当前状态与历史日志
    pushStatus();
    for (const entry of logEntries) {
      webviewView.webview.postMessage({ type: 'log', entry });
    }
  }
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin: 0; padding: 12px; box-sizing: border-box; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-sideBar-foreground); }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-terminal-ansiRed); flex-shrink: 0; }
  .dot.on { background: var(--vscode-terminal-ansiGreen); }
  .title { font-weight: 600; }
  .state { opacity: .75; font-size: 11px; }
  .url { font-size: 11px; opacity: .75; word-break: break-all; margin-bottom: 10px; font-family: var(--vscode-editor-font-family); }
  .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  button { font-family: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 3px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.sec { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.sec:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .sec-title { font-size: 11px; text-transform: uppercase; opacity: .6; margin: 4px 0 6px; letter-spacing: .5px; }
  .logs { display: flex; flex-direction: column; gap: 2px; font-size: 11px; font-family: var(--vscode-editor-font-family); line-height: 1.5; }
  .log { display: flex; gap: 6px; word-break: break-all; }
  .log .t { opacity: .45; flex-shrink: 0; }
  .log.warn { color: var(--vscode-editorWarning-foreground); }
  .log.error { color: var(--vscode-errorForeground); }
  .empty { opacity: .5; font-size: 11px; }
  .hint { font-size: 11px; opacity: .6; margin-top: 10px; line-height: 1.6; }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .settings { margin-bottom: 12px; }
  .settings .row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; cursor: pointer; user-select: none; }
  .settings input[type="checkbox"] { accent-color: var(--vscode-focusBorder); cursor: pointer; margin: 0; }
  .cmd-row { display: flex; gap: 6px; }
  .cmd-row input { flex: 1; min-width: 0; font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 3px 6px; outline: none; }
  .cmd-row input:focus { border-color: var(--vscode-focusBorder); }
  .desc { font-size: 11px; opacity: .6; margin-top: 4px; line-height: 1.5; }
</style>
</head>
<body>
  <div class="head">
    <span class="dot" id="dot"></span>
    <span class="title">DSH 服务</span>
    <span class="state" id="state">检测中…</span>
  </div>
  <div class="url" id="url"></div>
  <div class="btns">
    <button id="open">打开 WebUI</button>
    <button id="reload" class="sec">刷新页面</button>
    <button id="external" class="sec">浏览器</button>
    <button id="start">启动服务</button>
    <button id="stop" class="sec">停止服务</button>
  </div>
  <div class="sec-title">设置</div>
  <div class="settings">
    <label class="row"><input type="checkbox" id="autoStart"> 离线时自动启动服务</label>
    <div class="cmd-row">
      <input id="startCommand" type="text" placeholder="启动命令（留空自动检测）" spellcheck="false">
      <button id="saveCmd" class="sec">保存</button>
    </div>
    <div class="desc">服务离线约 6 秒后自动执行启动命令；留空自动检测（<code>dsh web</code> 或 <code>npx @deepseek-ai/dsh web</code>），也可在设置 <code>dsh.startCommand</code> 中修改。</div>
  </div>
  <div class="sec-title">运行日志</div>
  <div class="logs" id="logs"><div class="empty">暂无日志</div></div>
  <div class="hint">服务离线时扩展会自动启动 DSH（隐藏后台进程，不占用终端；服务日志在「输出 → DSH Server」查看）。启动命令可在设置 <code>dsh.startCommand</code> 中修改。</div>
<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const dot = $('dot'), state = $('state'), urlEl = $('url'), logs = $('logs');
  function setStatus(s) {
    dot.className = 'dot' + (s.online ? ' on' : '');
    state.textContent = s.online ? '在线' : '离线';
    urlEl.textContent = s.url;
    $('start').style.display = s.online ? 'none' : '';
    $('stop').style.display = s.running ? '' : 'none';
    $('autoStart').checked = !!s.autoStart;
    const cmdInput = $('startCommand');
    if (document.activeElement !== cmdInput && cmdInput.value !== (s.startCommand || '')) {
      cmdInput.value = s.startCommand || '';
    }
  }
  function addLog(e) {
    const empty = logs.querySelector('.empty');
    if (empty) { empty.remove(); }
    const div = document.createElement('div');
    div.className = 'log' + (e.level === 'warn' ? ' warn' : e.level === 'error' ? ' error' : '');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = e.time;
    const body = document.createElement('span');
    body.textContent = e.text;
    div.appendChild(t);
    div.appendChild(body);
    logs.prepend(div);
    while (logs.children.length > 150) { logs.lastChild.remove(); }
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'status') { setStatus(m); }
    else if (m.type === 'log') { addLog(m.entry); }
  });
  $('open').onclick = () => vscode.postMessage({ type: 'openPanel' });
  $('reload').onclick = () => vscode.postMessage({ type: 'reload' });
  $('external').onclick = () => vscode.postMessage({ type: 'openExternal' });
  $('start').onclick = () => vscode.postMessage({ type: 'startServer' });
  $('stop').onclick = () => vscode.postMessage({ type: 'stopServer' });
  $('autoStart').onchange = (e) => vscode.postMessage({ type: 'setAutoStart', value: e.target.checked });
  const saveCmd = () => vscode.postMessage({ type: 'setStartCommand', value: $('startCommand').value });
  $('saveCmd').onclick = saveCmd;
  $('startCommand').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveCmd(); }
  });
</script>
</body>
</html>`;
}

// ------------------------------------------------------------- WebUI 面板

function openPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  panel = vscode.window.createWebviewPanel(VIEW_TYPE, VIEW_TITLE, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true, // 面板隐藏时保留页面状态，切换回来不重新加载
  });
  panel.iconPath = new vscode.ThemeIcon('globe');
  setupPanel(panel, context);
  panel.onDidDispose(
    () => {
      panel = undefined;
      log('WebUI 面板已关闭');
    },
    undefined,
    context.subscriptions,
  );
  log(`已打开 WebUI 面板 (${getWebuiUrl()})`);
}

function setupPanel(p: vscode.WebviewPanel, context: vscode.ExtensionContext): void {
  // 接收来自面板的交互消息
  p.webview.onDidReceiveMessage(
    (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'retry') {
        online = false;
        renderPanel();
        schedulePoll(0);
      } else if (m?.type === 'openExternal') {
        void vscode.env.openExternal(vscode.Uri.parse(getWebuiUrl()));
      }
    },
    undefined,
    context.subscriptions,
  );
  renderPanel();
}

function renderPanel(): void {
  if (!panel) {
    return;
  }
  const url = getWebuiUrl();
  panel.title = online ? VIEW_TITLE : `${VIEW_TITLE} · 离线`;
  panel.webview.html = buildHtml(url, online);
}

function buildHtml(url: string, isOnline: boolean): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const escUrl = esc(url);
  // CSP：仅允许本扩展的样式/脚本，并把 frame-src 限定为 DSH 服务地址
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src ${escUrl};`;
  const common = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; }
  body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  #frame { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: #fff; }
  .center { height: 100%; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 440px; text-align: center; padding: 28px 32px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-editorWidget-background); }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--vscode-errorForeground); margin: 0 auto 16px; }
  h2 { margin: 0 0 12px; font-size: 16px; }
  p { margin: 6px 0; opacity: .85; font-size: 13px; }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 4px; word-break: break-all; }
  .btns { margin-top: 18px; display: inline-flex; gap: 10px; }
  button { font-family: inherit; font-size: 13px; padding: 6px 16px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 4px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>`;
  if (isOnline) {
    return `${common}
<iframe id="frame" src="${escUrl}" allow="fullscreen; clipboard-write"></iframe>
</body>
</html>`;
  }
  return `${common}
<div class="center">
  <div class="card">
    <div class="dot"></div>
    <h2>DSH 服务未连接</h2>
    <p>无法访问 <code>${escUrl}</code></p>
    <p>请先启动 DSH 服务，扩展会自动重试连接。</p>
    <div class="btns">
      <button id="retry">立即重试</button>
      <button id="external" class="secondary">浏览器打开</button>
    </div>
  </div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('retry').addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
  document.getElementById('external').addEventListener('click', () => vscode.postMessage({ type: 'openExternal' }));
</script>
</body>
</html>`;
}

// ------------------------------------------------------------- 服务启动/停止

// 启动命令：优先使用配置 dsh.startCommand；留空时自动检测
//  - PATH 中存在 dsh  -> "dsh web"
//  - 否则             -> "npx @deepseek-ai/dsh web"
function getStartCommand(): string {
  const configured = vscode.workspace.getConfiguration('dsh').get<string>('startCommand', '');
  const trimmed = (configured ?? '').trim();
  if (trimmed) {
    return trimmed;
  }
  return detectCommand('dsh') ? 'dsh web' : 'npx @deepseek-ai/dsh web';
}

function detectCommand(name: string): boolean {
  try {
    const isWin = process.platform === 'win32';
    const res = childProcess.spawnSync(isWin ? 'where' : 'which', [name], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return res.status === 0 && !!(res.stdout ?? '').trim();
  } catch {
    return false;
  }
}

// 以隐藏的后台子进程方式启动 DSH 服务（不占用终端，输出经管道转到 "DSH Server" 输出通道）
function startServer(source: string): void {
  if (serverProcess) {
    log('DSH 服务进程已在运行，无需重复启动', 'warn');
    return;
  }
  if (trackedPid && isProcessAlive(trackedPid)) {
    log(`先前会话遗留的服务进程 (PID ${trackedPid}) 仍在运行，无需重复启动；如需停止请使用「停止服务」`, 'warn');
    return;
  }
  const cmdLine = getStartCommand();
  if (!cmdLine) {
    log('未找到可用的启动命令：请在设置 dsh.startCommand 中配置，例如 "dsh web" 或 "npx @deepseek-ai/dsh web"', 'error');
    return;
  }
  if (!/\S/.test(cmdLine)) {
    log('启动命令无效（内容为空），请检查设置 dsh.startCommand', 'error');
    return;
  }
  log(`[${source}] 正在启动 DSH 服务: ${cmdLine}`);
  try {
    serverOutput.clear(); // 每次启动清空上一次的服务输出
    const proc = childProcess.spawn(cmdLine, {
      cwd: os.homedir(),
      env: { ...process.env, DSH_WEB_URL: getWebuiUrl() },
      shell: true, // 支持 dsh.cmd / npx 等命令
      windowsHide: true, // 不弹出控制台窗口
      detached: process.platform !== 'win32', // POSIX 下独立进程组，便于整树终止
      stdio: ['ignore', 'pipe', 'pipe'], // stdin 关闭，stdout/stderr 走管道
    });
    serverProcess = proc;
    if (proc.pid) {
      trackedPid = proc.pid;
      savePid(proc.pid);
    }
    pushStatus();
    log(`[${source}] DSH 服务进程已启动 (PID ${proc.pid ?? '?'})`);
    // 持续消费管道输出（否则子进程会因管道缓冲区写满而阻塞），转存到输出通道
    proc.stdout?.on('data', (chunk: Buffer) => {
      serverOutput.append(chunk.toString());
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      serverOutput.append(chunk.toString());
    });
    proc.on('error', (err: Error) => {
      log(`启动 DSH 服务失败: ${err.message}`, 'error');
      serverProcess = undefined;
      trackedPid = undefined;
      clearPid();
      pushStatus();
    });
    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      serverOutput.appendLine(`[DSH] 服务进程退出 (code=${code} signal=${signal})`);
      serverProcess = undefined;
      trackedPid = undefined;
      clearPid();
      log(`DSH 服务进程已退出 (code=${code} signal=${signal})`, code === 0 ? 'info' : 'warn');
      pushStatus();
    });
  } catch (err) {
    log(`启动 DSH 服务时发生异常: ${String(err)}`, 'error');
    serverProcess = undefined;
    pushStatus();
  }
}

function stopServer(): void {
  const pid = serverProcess?.pid ?? trackedPid;
  if (!pid) {
    log('当前没有由本扩展启动的服务进程', 'warn');
    return;
  }
  if (!isProcessAlive(pid)) {
    // 进程已不在，清理过期记录
    serverProcess = undefined;
    trackedPid = undefined;
    clearPid();
    log('服务进程已不在运行（记录已清理）', 'warn');
    pushStatus();
    return;
  }
  log(`正在停止 DSH 服务进程 (PID ${pid})…`);
  killServerTree(pid);
  if (!serverProcess) {
    // 遗留进程（无 exit 事件可依赖）：taskkill 同步结束后直接清理记录
    trackedPid = undefined;
    clearPid();
    pushStatus();
    log('已停止先前会话遗留的 DSH 服务进程');
  }
}

// ------------------------------------------------------------ 状态与轮询

function refreshStatusBar(): void {
  const url = getWebuiUrl();
  statusBar.text = online ? '$(globe) DSH' : '$(globe) DSH · 离线';
  statusBar.tooltip = `${online ? 'DSH 服务在线' : 'DSH 服务离线'} · ${url}`;
  statusBar.backgroundColor = online ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
}

function getWebuiUrl(): string {
  const configured = vscode.workspace.getConfiguration('dsh').get<string>('webuiUrl', DEFAULT_URL);
  const trimmed = (configured ?? '').trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_URL;
}

function schedulePoll(delayMs: number): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  pollTimer = setTimeout(() => {
    void pollOnce();
  }, delayMs);
}

// 周期性探测服务是否在线；离线达到阈值后自动拉起服务
async function pollOnce(): Promise<void> {
  try {
    const wasOnline = online;
    online = await isServerOnline();
    if (online !== wasOnline) {
      log(`服务状态: ${online ? '在线' : '离线'} (${getWebuiUrl()})`);
      refreshStatusBar();
      renderPanel();
      pushStatus();
    }
    if (online) {
      offlineStreak = 0;
    } else {
      offlineStreak++;
      maybeAutoStart();
    }
  } catch (err) {
    log(`轮询发生异常: ${String(err)}`, 'error');
  } finally {
    schedulePoll(POLL_INTERVAL_MS);
  }
}

function maybeAutoStart(): void {
  if (serverProcess || (trackedPid !== undefined && isProcessAlive(trackedPid))) {
    return; // 已有进程在启动中/运行中（含先前会话遗留）
  }
  if (!getAutoStart()) {
    return;
  }
  if (offlineStreak < AUTO_START_STREAK) {
    return;
  }
  const now = Date.now();
  if (now - lastStartAttempt < START_COOLDOWN_MS) {
    return; // 冷却期内不重复拉起
  }
  lastStartAttempt = now;
  startServer('自动');
}

function isServerOnline(): Promise<boolean> {
  const url = getWebuiUrl();
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const req = http.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
        res.resume(); // 丢弃响应体
        done(true);
      });
      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}
