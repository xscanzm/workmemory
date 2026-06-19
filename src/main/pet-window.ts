import { BrowserWindow, screen, ipcMain, app } from "electron";
import path from "path";
import { recorderService } from "./services/recorder";
import { configRepo } from "./database/repositories/config-repo";
import { IPC_CHANNELS, PetCharacter } from "../shared/types";

let petWindow: BrowserWindow | null = null;
let petEnabled: boolean = true;
let petCharacter: PetCharacter = "cat";
let statusListenerRegistered = false;

/**
 * 桌面常驻形象窗口管理
 * 透明、置顶、可拖动、点击穿透区域
 */
export async function createPetWindow(): Promise<void> {
  if (petWindow || !petEnabled) return;

  // 从配置读取初始状态
  const config = await configRepo.getConfig();
  petEnabled = config.petEnabled;
  petCharacter = config.petCharacter;
  if (!petEnabled) return;

  const { width } = screen.getPrimaryDisplay().workAreaSize;

  petWindow = new BrowserWindow({
    width: 120,
    height: 120,
    x: width - 140,
    y: 80,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 加载 pet 页面（通过 hash 路由）
  if (process.env.NODE_ENV === "development" || process.env.VITE_DEV_SERVER_URL) {
    petWindow.loadURL("http://localhost:5173/#/pet");
  } else {
    petWindow.loadFile(path.join(__dirname, "../renderer/index.html"), { hash: "/pet" });
  }

  petWindow.setIgnoreMouseEvents(false);

  // 状态变化时通知 pet
  if (!statusListenerRegistered) {
    statusListenerRegistered = true;
    recorderService.onStatusChange((status) => {
      sendPetStatus(status);
    });
  }

  // 窗口加载完成后发送初始状态和形象
  petWindow.webContents.once("did-finish-load", () => {
    sendPetStatus(recorderService.getStatus());
    sendPetCharacter(petCharacter);
  });
}

/**
 * 注册 Pet 相关 IPC handlers（在 registerIpcHandlers 中调用）
 */
export function registerPetIpcHandlers(): void {
  // Pet 点击 - 打开主窗口
  ipcMain.on(IPC_CHANNELS.PET_CLICK, () => {
    const { showMainWindow } = require("./window");
    showMainWindow();
  });

  // Pet 拖动
  ipcMain.on(IPC_CHANNELS.PET_DRAG, (_event, deltaX: number, deltaY: number) => {
    if (!petWindow) return;
    const [x, y] = petWindow.getPosition();
    petWindow.setPosition(x + deltaX, y + deltaY);
  });

  // 切换形象
  ipcMain.on(IPC_CHANNELS.PET_CYCLE_CHARACTER, async () => {
    const characters: PetCharacter[] = ["cat", "robot", "ghost", "droplet", "fox", "star"];
    const idx = characters.indexOf(petCharacter);
    petCharacter = characters[(idx + 1) % characters.length];
    await configRepo.saveConfig({ petCharacter });
    sendPetCharacter(petCharacter);
  });

  // 切换主窗口显示/隐藏
  ipcMain.on(IPC_CHANNELS.PET_TOGGLE_MAIN, () => {
    const { getMainWindow, showMainWindow } = require("./window");
    const win = getMainWindow();
    if (win && win.isVisible()) {
      win.hide();
    } else {
      showMainWindow();
    }
  });

  // 设置 Pet 启用状态
  ipcMain.handle(IPC_CHANNELS.SET_PET_ENABLED, async (_event, enabled: boolean) => {
    petEnabled = enabled;
    await configRepo.saveConfig({ petEnabled });
    if (enabled) {
      await createPetWindow();
    } else {
      destroyPetWindow();
    }
    return { enabled: petEnabled, character: petCharacter };
  });

  // 设置 Pet 形象
  ipcMain.handle(IPC_CHANNELS.SET_PET_CHARACTER, async (_event, character: string) => {
    petCharacter = character as PetCharacter;
    await configRepo.saveConfig({ petCharacter });
    sendPetCharacter(petCharacter);
    return { enabled: petEnabled, character: petCharacter };
  });

  // 获取 Pet 配置
  ipcMain.handle(IPC_CHANNELS.GET_PET_CONFIG, async () => {
    const config = await configRepo.getConfig();
    petEnabled = config.petEnabled;
    petCharacter = config.petCharacter;
    return { enabled: petEnabled, character: petCharacter };
  });
}

function sendPetStatus(status: string): void {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send(IPC_CHANNELS.PET_STATUS, status);
  }
}

function sendPetCharacter(character: string): void {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send(IPC_CHANNELS.PET_CHARACTER_CHANGE, character);
  }
}

export async function setPetEnabled(enabled: boolean): Promise<void> {
  petEnabled = enabled;
  if (enabled) {
    await createPetWindow();
  } else {
    destroyPetWindow();
  }
}

export async function setPetCharacter(character: PetCharacter): Promise<void> {
  petCharacter = character;
  sendPetCharacter(character);
}

export function getPetCharacter(): PetCharacter {
  return petCharacter;
}

export function isPetEnabled(): boolean {
  return petEnabled;
}

export function destroyPetWindow(): void {
  if (petWindow) {
    petWindow.destroy();
    petWindow = null;
  }
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow;
}

/**
 * 设置开机自启
 */
export function setLaunchAtStartup(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: ["--hidden"],
  });
}
