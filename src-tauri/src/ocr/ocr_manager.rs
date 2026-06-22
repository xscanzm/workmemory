/**
 * OcrManager：OCR 编排层单例（Rust 实现）
 *
 * 整合 WindowsOcrEngine + OcrQueue，提供统一入口。
 *
 * 职责：
 *  - initialize()：app ready 后调用，创建引擎与队列
 *  - set_model：Windows OCR API 不支持模型切换，固定使用系统语言
 *  - 暴露 IPC：ocr:getStatus、ocr:setModel、ocr:reprocess
 *  - set_save_screenshots(enabled)：联动截图保存设置
 *
 * 单例通过 once_cell::Lazy 提供。
 */
use std::sync::Mutex;

use once_cell::sync::Lazy;

use crate::models::OcrModel;
use crate::ocr::ocr_queue::{OcrQueue, OcrQueueConfig};
use crate::ocr::windows_ocr_engine::WindowsOcrEngine;
use crate::repositories::segment_repository::SegmentRepository;

/// OCR 管理器状态
#[derive(Debug, Clone, serde::Serialize)]
pub struct OcrManagerStatus {
    /// 后端类型：'windows_ocr' | 'unconfigured'
    pub backend: String,
    /// 当前模型（Windows OCR 固定 'tiny'，仅为兼容 IPC 契约）
    pub model: OcrModel,
    /// 引擎是否已加载
    pub loaded: bool,
    /// 队列大小
    pub queue_size: usize,
    /// 是否运行中
    pub running: bool,
    /// 是否已配置（有可用后端）
    pub configured: bool,
}

/// 后端状态（供设置页展示）
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackendStatus {
    /// 后端类型：'windows_ocr' | 'unconfigured'
    #[serde(rename = "type")]
    pub backend_type: String,
    /// 模型路径（Windows OCR 无独立模型文件，返回空字符串）
    pub model_path: String,
    /// 是否可用
    pub available: bool,
}

/// OcrManager：OCR 编排层
pub struct OcrManager {
    /// OCR 队列（运行时创建）
    queue: Option<OcrQueue>,
    /// 当前模型
    model: OcrModel,
    /// 是否已初始化
    initialized: bool,
    /// 是否运行中
    running: bool,
    /// 是否已配置（有可用后端）
    configured: bool,
    /// 是否保存截图
    save_screenshots: bool,
    /// 引擎实例（用于 recognize_image_path）
    engine: Option<WindowsOcrEngine>,
}

impl OcrManager {
    /// 创建 OcrManager
    fn new() -> Self {
        Self {
            queue: None,
            model: OcrModel::Tiny,
            initialized: false,
            running: false,
            configured: false,
            save_screenshots: false,
            engine: None,
        }
    }

    /// 初始化：app ready 后调用。
    ///
    /// 创建引擎、启动队列。
    /// 无可用后端时进入"未配置"状态：记录警告日志，不抛错，
    /// OCR 队列暂停（不 enqueue、不处理），segment.source_status 停留 'pending'，
    /// CaptureManager 仍可运行（截图照常，只是不 OCR）。
    pub fn initialize(&mut self, model: OcrModel) -> anyhow::Result<()> {
        if self.initialized {
            return Ok(());
        }
        self.model = model;

        // 创建引擎并尝试初始化
        let mut engine = WindowsOcrEngine::new();
        if let Err(e) = engine.initialize() {
            log::warn!("[OcrManager] OCR 引擎初始化异常: {}", e);
        }

        // 检测是否已配置后端
        self.configured = engine.is_available();
        if !self.configured {
            log::warn!(
                "[OcrManager] OCR 后端未配置，OCR 队列暂停。截图功能正常，segment 将保持 pending 状态。"
            );
        }

        // 创建队列（即使未配置也创建，enqueue 时会检查 configured）
        let mut queue = OcrQueue::new(
            WindowsOcrEngine::new(), // 队列持有独立引擎实例
            OcrQueueConfig {
                save_screenshots: self.save_screenshots,
                concurrency: 1,
                idle_release_ms: 10000,
            },
        );

        // 启动队列
        // 注意：start 是 async，但 initialize 是同步的
        // 使用 tokio::task::block_in_place 或在调用方异步启动
        // 这里采用同步启动方式：通过 tokio runtime handle
        let runtime = tokio::runtime::Handle::try_current();
        match runtime {
            Ok(handle) => {
                let queue_ref = &mut queue;
                handle.block_on(async {
                    queue_ref.start().await;
                });
            }
            Err(_) => {
                log::warn!("[OcrManager] 无 tokio runtime，队列未启动");
            }
        }

        self.running = true;
        self.engine = Some(engine);
        self.queue = Some(queue);
        self.initialized = true;

        if self.configured {
            log::info!("[OcrManager] 初始化完成");
        } else {
            log::info!("[OcrManager] 初始化完成（未配置 OCR 后端）");
        }
        Ok(())
    }

    /// 获取当前状态
    pub fn get_status(&self) -> OcrManagerStatus {
        let queue_size = match &self.queue {
            Some(q) => {
                // 同步获取队列大小（通过 try_lock）
                // 由于 OcrManager 是单例且通常在 tokio runtime 中调用，
                // 这里使用 block_on 获取
                let runtime = tokio::runtime::Handle::try_current();
                match runtime {
                    Ok(handle) => handle.block_on(async { q.get_queue_size().await }),
                    Err(_) => 0,
                }
            }
            None => 0,
        };
        let loaded = self
            .engine
            .as_ref()
            .map(|e| e.is_available())
            .unwrap_or(false);
        OcrManagerStatus {
            backend: if self.configured {
                "windows_ocr".to_string()
            } else {
                "unconfigured".to_string()
            },
            model: self.model,
            loaded,
            queue_size,
            running: self.running,
            configured: self.configured,
        }
    }

    /// 获取当前模型
    pub fn get_model(&self) -> OcrModel {
        self.model
    }

    /// 获取 OCR runtime 状态
    pub fn get_runtime_status(&self) -> BackendStatus {
        let available = self
            .engine
            .as_ref()
            .map(|e| e.is_available())
            .unwrap_or(false);
        BackendStatus {
            backend_type: if available {
                "windows_ocr".to_string()
            } else {
                "unconfigured".to_string()
            },
            model_path: String::new(), // Windows OCR 无独立模型文件
            available,
        }
    }

    /// 切换模型（Windows OCR API 不支持模型切换，固定使用系统语言）。
    /// 仅为兼容 IPC 契约，记录模型选择但实际不切换。
    pub fn set_model(&mut self, model: OcrModel) -> bool {
        self.model = model;
        // Windows OCR 固定使用系统语言，不切换
        log::info!(
            "[OcrManager] set_model({:?}) — Windows OCR 固定使用系统语言，不切换",
            model
        );
        self.configured
    }

    /// 重新处理指定 Segment。
    /// 将 Segment 重置为 pending 状态并重新入队。
    /// OCR 后端未配置时返回 false（segment 保持 pending 但不入队）。
    pub fn reprocess(&self, segment_id: &str) -> bool {
        let segment = match SegmentRepository::get_by_id(segment_id) {
            Ok(Some(s)) => s,
            _ => return false,
        };

        // 重置为 pending 状态
        let mut patch = crate::models::WorkSegment::default();
        patch.source_status = crate::models::SourceStatus::Pending;
        patch.ocr_text = String::new();
        patch.ocr_summary = String::new();
        if SegmentRepository::update(segment_id, patch).is_err() {
            return false;
        }

        // OCR 后端未配置时不入队
        if !self.configured {
            return false;
        }

        // 入队
        if let Some(queue) = &self.queue {
            let runtime = tokio::runtime::Handle::try_current();
            if let Ok(handle) = runtime {
                handle.block_on(async {
                    queue.enqueue(segment_id.to_string()).await;
                });
                return true;
            }
        }
        false
    }

    /// 设置是否保存截图（联动 OcrQueue）
    pub fn set_save_screenshots(&mut self, enabled: bool) {
        self.save_screenshots = enabled;
        if let Some(queue) = &self.queue {
            let runtime = tokio::runtime::Handle::try_current();
            if let Ok(handle) = runtime {
                let new_config = OcrQueueConfig {
                    save_screenshots: enabled,
                    concurrency: 1,
                    idle_release_ms: 10000,
                };
                handle.block_on(async {
                    queue.update_config(new_config).await;
                });
            }
        }
    }

    /// 手动入队 Segment（OCR 后端未配置时忽略）
    pub fn enqueue(&self, segment_id: String) {
        if !self.configured {
            return;
        }
        if let Some(queue) = &self.queue {
            let runtime = tokio::runtime::Handle::try_current();
            if let Ok(handle) = runtime {
                handle.block_on(async {
                    queue.enqueue(segment_id).await;
                });
            }
        }
    }

    /// 直接识别指定图片路径的文本（绕过队列，供 IPC ocr:recognize 使用）。
    /// 无可用后端或读取失败时抛错，不返回伪造数据。
    pub fn recognize_image_path(&mut self, image_path: &str) -> anyhow::Result<String> {
        if !self.configured {
            return Err(anyhow::anyhow!(
                "未配置 OCR 后端，Windows OCR API 不可用"
            ));
        }
        if !std::path::Path::new(image_path).exists() {
            return Err(anyhow::anyhow!("图片文件不存在: {}", image_path));
        }
        let engine = self
            .engine
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("OCR 引擎未初始化"))?;
        if !engine.is_available() {
            engine.initialize()?;
        }
        let image_buffer =
            std::fs::read(image_path).map_err(|e| anyhow::anyhow!("读取图片失败: {}", e))?;
        let result = engine.recognize(&image_buffer)?;
        Ok(result.text)
    }

    /// 停止管理器
    pub fn stop(&mut self) {
        if let Some(queue) = &self.queue {
            let runtime = tokio::runtime::Handle::try_current();
            if let Ok(handle) = runtime {
                handle.block_on(async {
                    queue.stop().await;
                });
            }
        }
        if let Some(engine) = self.engine.as_mut() {
            engine.release();
        }
        self.running = false;
    }
}

// ===================== 单例 =====================

static OCR_MANAGER: Lazy<Mutex<OcrManager>> = Lazy::new(|| Mutex::new(OcrManager::new()));

/// 获取 OcrManager 单例（Mutex 守卫）
pub fn get_ocr_manager() -> &'static Mutex<OcrManager> {
    &OCR_MANAGER
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ocr_manager_new() {
        let manager = OcrManager::new();
        assert!(!manager.initialized);
        assert!(!manager.running);
        assert!(!manager.configured);
        assert_eq!(manager.model, OcrModel::Tiny);
    }

    #[test]
    fn test_backend_status_serialization() {
        let status = BackendStatus {
            backend_type: "windows_ocr".to_string(),
            model_path: String::new(),
            available: true,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("windows_ocr"));
        assert!(json.contains("\"type\""));
    }

    #[test]
    fn test_ocr_manager_status_serialization() {
        let status = OcrManagerStatus {
            backend: "windows_ocr".to_string(),
            model: OcrModel::Tiny,
            loaded: true,
            queue_size: 0,
            running: true,
            configured: true,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("windows_ocr"));
        assert!(json.contains("tiny"));
    }
}
