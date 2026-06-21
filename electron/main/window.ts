/**
 * 主窗口管理：无边框定制窗口
 * frame: false + 自定义标题栏；亚克力背景；合理最小尺寸。
 */
import { BrowserWindow, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

let mainWindow: BrowserWindow | null = null

function logWindow(message: string): void {
  try {
    const filePath = path.join(app.getPath('userData'), 'runtime.log')
    fs.appendFileSync(filePath, `[${new Date().toISOString()}] [window] ${message}\n`, 'utf-8')
  } catch {
    // ignore logging failures
  }
}

function showWindowOnce(win: BrowserWindow, reason: string): void {
  if (win.isDestroyed() || win.isVisible()) return
  logWindow(`show main window: ${reason}`)
  win.show()
  win.focus()
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    transparent: false,
    backgroundColor: '#f5f7fa',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  })
  mainWindow = win

  // 窗口就绪后展示，避免白屏闪烁
  win.once('ready-to-show', () => {
    showWindowOnce(win, 'ready-to-show')
  })
  win.webContents.once('did-finish-load', () => {
    showWindowOnce(win, 'did-finish-load')
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logWindow(`did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
    showWindowOnce(win, 'did-fail-load')
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logWindow(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.webContents.on('unresponsive', () => {
    logWindow('renderer unresponsive')
  })
  setTimeout(() => showWindowOnce(win, 'fallback-timeout'), 3000)

  // 最大化状态变化通知渲染进程（用于切换标题栏按钮图标）
  win.on('maximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximizeChanged', true)
  })
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximizeChanged', false)
  })
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    logWindow(`loadURL ${devUrl}`)
    void win.loadURL(devUrl)
  } else {
    const filePath = path.join(__dirname, '../../dist/index.html')
    logWindow(`loadFile ${filePath}`)
    void win.loadFile(filePath).catch((e) => {
      logWindow(`loadFile failed: ${e instanceof Error ? e.message : String(e)}`)
      showWindowOnce(win, 'loadFile-catch')
    })
  }

  return win
}

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && mainWindow.isDestroyed()) {
    mainWindow = null
  }
  return mainWindow
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function showMainWindow(): BrowserWindow {
  const win = createMainWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}
