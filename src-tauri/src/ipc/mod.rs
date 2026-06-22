//! IPC 模块：Tauri 命令层（对应 electron/ipc/ 与 electron/main/ipc.ts）
//!
//! 模块组织：
//!  - `commands`：全部 `#[tauri::command]` 命令实现
//!  - `schemas`：IPC 请求/响应类型定义（对应 electron/ipc/schemas.ts）
//!  - `validated_handler`：入参校验工具（对应 electron/ipc/validatedHandler.ts）

pub mod commands;
pub mod schemas;
pub mod validated_handler;
