import { app } from "electron";
import { createMainWindow, showMainWindow } from "./window";
import { createTray, destroyTray } from "./tray";
import { registerIpcHandlers } from "./ipc-handlers";
import { getDatabase, closeDatabase } from "./database/connection";
import { recorderService } from "./services/recorder";
import { captureService } from "./services/capture";
import { privacyRepo } from "./database/repositories/privacy-repo";
import { templateRepo } from "./database/repositories/template-repo";
import { eventLogRepo } from "./database/repositories/event-log-repo";
import { configRepo } from "./database/repositories/config-repo";
import { createPetWindow, destroyPetWindow, registerPetIpcHandlers, setLaunchAtStartup } from "./pet-window";
import { insightsService } from "./services/insights-service";

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on("second-instance", () => {
  showMainWindow();
});

app.whenReady().then(async () => {
  try {
    // Initialize database
    await getDatabase();

    // Seed default data (templates auto-seed on first getAll, privacy rules seed here)
    await privacyRepo.seedDefaultRules();
    await templateRepo.getAll();

    // Register IPC handlers (including pet handlers)
    registerIpcHandlers();
    registerPetIpcHandlers();

    // Create tray
    createTray();

    // Create main window (unless started hidden for auto-launch)
    const startHidden = process.argv.includes("--hidden");
    if (!startHidden) {
      createMainWindow();
    } else {
      // 隐藏启动时仍创建窗口但不显示
      createMainWindow();
      const { getMainWindow } = require("./window");
      const win = getMainWindow();
      if (win) win.hide();
    }

    // Start recorder (this now starts the full recording pipeline)
    recorderService.start();

    // Create desktop pet window (if enabled)
    createPetWindow();

    // Apply auto-launch setting
    const config = await configRepo.getConfig();
    setLaunchAtStartup(config.launchAtStartup);

    // 启动后异步刷新洞察（不阻塞启动）
    setTimeout(async () => {
      try {
        await insightsService.refresh();
      } catch (error) {
        console.warn("Insights refresh failed:", error);
      }
    }, 10000);

    await eventLogRepo.info("app", "应用已启动");
  } catch (error: any) {
    console.error("应用启动失败:", error);
    await eventLogRepo.error("app", `应用启动失败: ${error?.message}`, error?.stack);
  }
});

app.on("window-all-closed", () => {
  // Don't quit on window close - keep running in tray
});

app.on("before-quit", () => {
  recorderService.pause();
  captureService.cleanTempDir();
  destroyTray();
  destroyPetWindow();
  closeDatabase();
});

app.on("activate", () => {
  showMainWindow();
});
