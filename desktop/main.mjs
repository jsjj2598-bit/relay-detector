/**
 * 桌面端主进程（Electron）。
 *
 * 设计要点：**不重新实现任何东西**，只做三件事：
 *   1. 在进程内启动仓库里已有的本地代理（`proxy/server.mjs` 的 `createServer()`）；
 *   2. 用一个窗口加载这个代理托管的同一份页面；
 *   3. 通过 URL 参数把页面预置成「本地代理」模式。
 *
 * 于是桌面端天然拥有：绕过 CORS、完整响应头、TLS 证书读取（`/inspect`）、
 * 以及 SSRF 防护 —— 全部复用已有、已测试的实现。
 *
 * 端口用 0（系统分配），避免和用户已开的 8787 冲突。
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ⚠️ 在 ESM 主进程里直接 `import { app } from 'electron'` 会失败：
// 裸导入 'electron' 可能被 Node 的 ESM 解析器解析成 node_modules 里的 npm 包
// （它的默认导出只是一个可执行文件路径字符串），于是报
// "does not provide an export named 'BrowserWindow'" 或 app 为 undefined。
// 正确做法：用 createRequire 走 Electron 内置的 CJS 拦截。
const require = createRequire(import.meta.url);
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
import { createServer, CFG } from '../proxy/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('electron').BrowserWindow | null} */
let win = null;
/** @type {import('node:http').Server | null} */
let server = null;
let baseUrl = '';

/** 在进程内启动本地代理，返回实际监听地址。 */
function startLocalServer() {
  return new Promise((resolve, reject) => {
    CFG.host = '127.0.0.1';
    CFG.port = 0; // 让系统分配空闲端口
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server: s, url: `http://127.0.0.1:${port}` });
    });
  });
}

function createWindow(url) {
  const w = new BrowserWindow({
    width: 1280,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: '中转站检测器',
    backgroundColor: '#0b1120',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // 页面是纯前端，不需要任何 Node 能力：保持最严格的隔离。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  w.once('ready-to-show', () => w.show());

  // 外链一律交给系统浏览器，绝不在应用内打开
  w.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith(baseUrl)) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });

  // 预置「本地代理」模式，并把代理地址指回自己
  const entry = `${url}/?mode=proxy&proxyUrl=${encodeURIComponent(url)}&desktop=1`;
  w.loadURL(entry);
  return w;
}

/** 极简菜单：只留「重新加载 / 开发者工具 / 关于 / 退出」。 */
function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '应用',
      submenu: [
        { label: '重新加载页面', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.reload() },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: () => win?.webContents.toggleDevTools() },
        { type: 'separator' },
        {
          label: '打开本地代理健康检查',
          click: () => {
            if (baseUrl) shell.openExternal(`${baseUrl}/health`);
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '说明：为什么桌面端更准',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于桌面端',
              message: '桌面端内置本地代理',
              detail:
                '同一个页面，但请求由本机进程发出，因此：\n' +
                '· 不受浏览器 CORS 限制；\n' +
                '· 能读到完整响应头；\n' +
                '· 能读取 TLS 证书签发者与有效期。\n\n' +
                'API Key 只存在于本机内存与发往目标站的请求头里，不会上传到任何第三方服务器。'
            });
          }
        }
      ]
    }
  ]);
}

// 单实例：重复启动时聚焦已有窗口，而不是再开一个
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const started = await startLocalServer();
      server = started.server;
      baseUrl = started.url;
      win = createWindow(baseUrl);
      Menu.setApplicationMenu(buildMenu());
    } catch (err) {
      dialog.showErrorBox('启动失败', `本地代理未能启动：\n${err?.message || err}`);
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && baseUrl) win = createWindow(baseUrl);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    try {
      server?.close();
    } catch {
      /* ignore */
    }
  });
}
