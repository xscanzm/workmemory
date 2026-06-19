import { Tray, Menu, nativeImage, app } from "electron";
import { showMainWindow } from "./window";
import { recorderService } from "./services/recorder";
import { RecorderStatus } from "../shared/types";

let tray: Tray | null = null;

export function createTray(): void {
  const icon = createTrayIcon(recorderService.getStatus());
  tray = new Tray(icon);
  tray.setToolTip("今日记忆");

  updateTrayMenu();
  tray.on("click", () => {
    showMainWindow();
  });

  // 状态变化时联动更新托盘图标和菜单
  recorderService.onStatusChange((status) => {
    updateTrayStatus(status);
  });
}

function updateTrayMenu(): void {
  if (!tray) return;

  const status = recorderService.getStatus();
  const isRecording = status === "recording";
  const isPrivacyMode = status === "privacy_mode";

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "打开今日记忆",
      click: () => showMainWindow(),
    },
    { type: "separator" },
    {
      label: isRecording ? "暂停记录" : "恢复记录",
      click: () => {
        if (isRecording) {
          recorderService.pause();
        } else {
          recorderService.resume();
        }
      },
    },
    {
      label: isPrivacyMode ? "退出隐私模式" : "隐私模式",
      click: () => {
        if (isPrivacyMode) {
          recorderService.disablePrivacyMode();
        } else {
          recorderService.enablePrivacyMode();
        }
      },
    },
    { type: "separator" },
    {
      label: "生成日报",
      click: () => {
        showMainWindow();
        const { getMainWindow } = require("./window");
        const win = getMainWindow();
        if (win) {
          win.webContents.send("navigate", "/report");
        }
      },
    },
    {
      label: "设置",
      click: () => {
        showMainWindow();
        const { getMainWindow } = require("./window");
        const win = getMainWindow();
        if (win) {
          win.webContents.send("navigate", "/settings");
        }
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        recorderService.pause();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * 根据状态创建托盘图标
 * recording: 绿色 / paused: 灰色 / privacy_mode: 橙色 / error: 红色
 */
function createTrayIcon(status: RecorderStatus): Electron.NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);

  // 根据状态选择颜色 (R, G, B)
  let r = 0, g = 180, b = 0;
  switch (status) {
    case "recording":
      r = 0; g = 180; b = 0; break;       // 绿色
    case "paused":
      r = 160; g = 160; b = 160; break;    // 灰色
    case "privacy_mode":
      r = 230; g = 140; b = 0; break;      // 橙色
    case "error":
      r = 220; g = 50; b = 50; break;      // 红色
    case "initializing":
      r = 120; g = 120; b = 180; break;    // 蓝灰色
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const cx = 8, cy = 8, radius = 6;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

      if (dist <= radius) {
        buffer[idx] = r;
        buffer[idx + 1] = g;
        buffer[idx + 2] = b;
        buffer[idx + 3] = 255;
      } else {
        buffer[idx + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

/**
 * 状态变化时更新托盘图标和菜单
 */
export function updateTrayStatus(status?: RecorderStatus): void {
  if (!tray) return;
  const currentStatus = status || recorderService.getStatus();
  tray.setImage(createTrayIcon(currentStatus));
  updateTrayMenu();
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

export { tray };
