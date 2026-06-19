import { BrowserWindow, screen } from "electron";
import path from "path";

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  if (mainWindow) {
    mainWindow.focus();
    return mainWindow;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1200, width),
    height: Math.min(800, height),
    minWidth: 900,
    minHeight: 600,
    title: "今日记忆",
    icon: path.join(__dirname, "../../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  // Load renderer
  if (process.env.NODE_ENV === "development" || process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (event) => {
    // Minimize to tray instead of closing
    if (mainWindow && !mainWindow.isDestroyed()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function showMainWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createMainWindow();
  }
}

export function closeMainWindow(): void {
  if (mainWindow) {
    mainWindow.destroy();
    mainWindow = null;
  }
}

// ==========================================
// MiniSearch 全局闪查窗口
// ==========================================
let miniSearchWindow: BrowserWindow | null = null;

export function createMiniSearchWindow(): BrowserWindow {
  if (miniSearchWindow && !miniSearchWindow.isDestroyed()) {
    return miniSearchWindow;
  }
  miniSearchWindow = new BrowserWindow({
    width: 760,
    height: 480,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // 加载 mini-search 页面（通过 hash 路由）
  if (process.env.NODE_ENV === "development" || process.env.VITE_DEV_SERVER_URL) {
    miniSearchWindow.loadURL("http://localhost:5173/#/mini-search");
  } else {
    miniSearchWindow.loadFile(path.join(__dirname, "../renderer/index.html"), { hash: "/mini-search" });
  }
  // 失焦自动隐藏
  miniSearchWindow.on("blur", () => {
    miniSearchWindow?.hide();
  });
  return miniSearchWindow;
}

export function getMiniSearchWindow(): BrowserWindow | null {
  return miniSearchWindow;
}

export function showMiniSearchWindow(): void {
  if (!miniSearchWindow || miniSearchWindow.isDestroyed()) {
    createMiniSearchWindow();
  }
  // 跟随鼠标所在显示器居中偏上 1/3
  const { x, y } = screen.getCursorScreenPoint();
  const currentDisplay = screen.getDisplayNearestPoint({ x, y });
  const { width, height } = currentDisplay.workArea;
  const winWidth = 760;
  const winHeight = 480;
  miniSearchWindow!.setPosition(
    Math.round(currentDisplay.workArea.x + (width - winWidth) / 2),
    Math.round(currentDisplay.workArea.y + (height - winHeight) / 3)
  );
  miniSearchWindow!.show();
  miniSearchWindow!.focus();
}

export function hideMiniSearchWindow(): void {
  if (miniSearchWindow && !miniSearchWindow.isDestroyed()) {
    miniSearchWindow.hide();
  }
}

export { mainWindow };