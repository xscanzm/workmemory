/**
 * OcrQueue：OCR 处理队列（Rust 实现）
 *
 * 与截图队列解耦，串行处理 pending Segments（避免 CPU 抢占）。
 *
 * 职责：
 *  - 队列管理：pending Segments 入队，串行处理
 *  - process_next()：取队首 Segment → 读取临时截图 → WindowsOcrEngine.recognize →
 *    更新 Segment（ocr_text, ocr_summary, source_status）→ 删除临时截图 →
 *    发布 OcrCompleted 事件
 *  - 空闲资源管理：队列空后启动 10 秒计时器，到期调用 engine.release()，
 *    新任务到来时重新 initialize
 *  - 事件：通过 EventBus 发布 OcrCompleted / OcrFailed
 *
 * 并发控制：默认单任务串行（CPU OCR 不宜并发），可配置。
 *
 * 注意：Phase 3 阶段仅实现 OCR 核心流程，感知增强（5 个分类器）在 Phase 4 T4.6 实现。
 */
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::events::bus::{AppEvent, EventBus};
use crate::models::{SourceQuality, SourceStatus, WorkSegment};
use crate::ocr::ocr_text_cleaner::get_ocr_text_cleaner;
use crate::ocr::windows_ocr_engine::WindowsOcrEngine;
use crate::repositories::segment_repository::SegmentRepository;

/// OcrQueue 配置
#[derive(Debug, Clone)]
pub struct OcrQueueConfig {
    /// 是否保存截图（true 时 OCR 后不删除临时截图）
    pub save_screenshots: bool,
    /// 并发数（默认 1，CPU OCR 串行）
    pub concurrency: usize,
    /// 空闲释放时长（毫秒，默认 10000）
    pub idle_release_ms: u64,
}

impl Default for OcrQueueConfig {
    fn default() -> Self {
        Self {
            save_screenshots: false,
            concurrency: 1,
            idle_release_ms: 10000,
        }
    }
}

/// ocr_summary 截断长度
const OCR_SUMMARY_MAX_LENGTH: usize = 200;

/// OcrQueue：OCR 处理队列
///
/// 事件（通过 EventBus 发布）：
///  - OcrCompleted：单个 Segment OCR 完成
///  - OcrFailed：单个 Segment OCR 失败
pub struct OcrQueue {
    /// OCR 引擎（Arc<Mutex> 保证线程安全）
    engine: Arc<Mutex<WindowsOcrEngine>>,
    /// 配置
    config: Arc<Mutex<OcrQueueConfig>>,
    /// 待处理队列（segmentId 去重）
    queue: Arc<Mutex<VecDeque<String>>>,
    /// 正在处理中的 segmentId 集合
    processing: Arc<Mutex<std::collections::HashSet<String>>>,
    /// 队列是否已启动
    running: Arc<Mutex<bool>>,
    /// worker 任务句柄
    worker_handle: Option<JoinHandle<()>>,
    /// 空闲释放任务句柄
    idle_handle: Option<JoinHandle<()>>,
}

impl OcrQueue {
    /// 创建 OcrQueue
    pub fn new(engine: WindowsOcrEngine, config: OcrQueueConfig) -> Self {
        Self {
            engine: Arc::new(Mutex::new(engine)),
            config: Arc::new(Mutex::new(config)),
            queue: Arc::new(Mutex::new(VecDeque::new())),
            processing: Arc::new(Mutex::new(std::collections::HashSet::new())),
            running: Arc::new(Mutex::new(false)),
            worker_handle: None,
            idle_handle: None,
        }
    }

    /// 更新配置
    pub async fn update_config(&self, patch: OcrQueueConfig) {
        let mut cfg = self.config.lock().await;
        *cfg = patch;
    }

    /// 启动队列
    pub async fn start(&mut self) {
        let mut running = self.running.lock().await;
        if *running {
            return;
        }
        *running = true;
        drop(running);

        // 启动 worker 任务
        let engine = self.engine.clone();
        let config = self.config.clone();
        let queue = self.queue.clone();
        let processing = self.processing.clone();
        let running_clone = self.running.clone();

        self.worker_handle = Some(tokio::spawn(async move {
            worker_loop(engine, config, queue, processing, running_clone).await;
        }));
    }

    /// 停止队列
    pub async fn stop(&self) {
        let mut running = self.running.lock().await;
        *running = false;
        drop(running);

        if let Some(handle) = self.worker_handle.as_ref() {
            handle.abort();
        }
    }

    /// 入队一个 Segment
    pub async fn enqueue(&self, segment_id: String) {
        // 去重检查
        {
            let mut q = self.queue.lock().await;
            let mut p = self.processing.lock().await;
            if q.contains(&segment_id) || p.contains(&segment_id) {
                return;
            }
            q.push_back(segment_id);
        }
        // 唤醒 worker（通过队列非空自然唤醒）
    }

    /// 获取队列大小（待处理 + 处理中）
    pub async fn get_queue_size(&self) -> usize {
        let q = self.queue.lock().await;
        let p = self.processing.lock().await;
        q.len() + p.len()
    }

    /// 队列是否为空
    pub async fn is_empty(&self) -> bool {
        let q = self.queue.lock().await;
        let p = self.processing.lock().await;
        q.is_empty() && p.is_empty()
    }
}

impl Drop for OcrQueue {
    fn drop(&mut self) {
        if let Some(handle) = self.worker_handle.take() {
            handle.abort();
        }
        if let Some(handle) = self.idle_handle.take() {
            handle.abort();
        }
    }
}

/// worker 循环：持续从队列取任务并处理
async fn worker_loop(
    engine: Arc<Mutex<WindowsOcrEngine>>,
    config: Arc<Mutex<OcrQueueConfig>>,
    queue: Arc<Mutex<VecDeque<String>>>,
    processing: Arc<Mutex<std::collections::HashSet<String>>>,
    running: Arc<Mutex<bool>>,
) {
    loop {
        // 检查运行状态
        {
            let r = running.lock().await;
            if !*r {
                return;
            }
        }

        // 取队首任务
        let segment_id = {
            let mut q = queue.lock().await;
            q.pop_front()
        };

        let segment_id = match segment_id {
            Some(id) => id,
            None => {
                // 队列为空，短暂休眠后重试
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };

        // 加入处理中集合
        {
            let mut p = processing.lock().await;
            p.insert(segment_id.clone());
        }

        // 处理任务
        process_segment(&segment_id, &engine, &config).await;

        // 从处理中集合移除
        {
            let mut p = processing.lock().await;
            p.remove(&segment_id);
        }

        // 检查队列是否为空，启动空闲计时器
        let is_empty_now = {
            let q = queue.lock().await;
            let p = processing.lock().await;
            q.is_empty() && p.is_empty()
        };
        if is_empty_now {
            let idle_ms = config.lock().await.idle_release_ms;
            // 等待 idle_ms，如果期间有新任务到来则取消
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(idle_ms)) => {
                    // 空闲超时，释放引擎
                    let mut eng = engine.lock().await;
                    eng.release();
                    log::info!("[OcrQueue] 空闲释放 OCR 引擎");
                }
                _ = wait_for_new_task(&queue) => {
                    // 有新任务到来，取消空闲等待
                }
            }
        }
    }
}

/// 等待队列有新任务
async fn wait_for_new_task(queue: &Arc<Mutex<VecDeque<String>>>) {
    loop {
        {
            let q = queue.lock().await;
            if !q.is_empty() {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 处理单个 Segment
async fn process_segment(
    segment_id: &str,
    engine: &Arc<Mutex<WindowsOcrEngine>>,
    config: &Arc<Mutex<OcrQueueConfig>>,
) {
    match process_segment_inner(segment_id, engine, config).await {
        Ok(_) => {
            EventBus::publish(AppEvent::OcrCompleted {
                segment_id: segment_id.to_string(),
            });
        }
        Err(e) => {
            log::warn!("[OcrQueue] Segment {} OCR 失败: {}", segment_id, e);
            // 标记为 ocr_failed
            let _ = SegmentRepository::update(
                segment_id,
                WorkSegment {
                    source_status: SourceStatus::OcrFailed,
                    ocr_text: String::new(),
                    ocr_summary: String::new(),
                    ocr_blocks: Vec::new(),
                    ocr_confidence: 0.0,
                    source_quality: SourceQuality::Failed,
                    ..Default::default()
                },
            );
            EventBus::publish(AppEvent::OcrFailed {
                segment_id: segment_id.to_string(),
                error: e.to_string(),
            });
        }
    }
}

/// 处理 Segment 内部实现
async fn process_segment_inner(
    segment_id: &str,
    engine: &Arc<Mutex<WindowsOcrEngine>>,
    config: &Arc<Mutex<OcrQueueConfig>>,
) -> anyhow::Result<()> {
    // 1. 读取 Segment
    let segment = SegmentRepository::get_by_id(segment_id)?
        .ok_or_else(|| anyhow::anyhow!("Segment {} 不存在", segment_id))?;

    // 已删除的 Segment 跳过
    if segment.is_deleted {
        return Ok(());
    }

    // 非 pending 状态跳过（已处理过）
    if segment.source_status != SourceStatus::Pending {
        return Ok(());
    }

    // 2. 读取临时截图
    let screenshot_path = if !segment.screenshot_path.is_empty() {
        PathBuf::from(&segment.screenshot_path)
    } else {
        // 无截图文件，标记为 ocr_failed
        return Err(anyhow::anyhow!("截图文件路径为空"));
    };

    if !screenshot_path.exists() {
        return Err(anyhow::anyhow!("截图文件不存在: {:?}", screenshot_path));
    }

    // 3. 确保引擎已加载
    {
        let mut eng = engine.lock().await;
        if !eng.is_available() {
            eng.initialize()?;
        }
        if !eng.is_available() {
            // 未配置状态，保持 pending
            log::warn!("[OcrQueue] OCR 后端未配置，Segment {} 保持 pending 状态", segment_id);
            return Ok(());
        }
    }

    // 4. 读取截图文件
    let image_buffer = std::fs::read(&screenshot_path)
        .map_err(|e| anyhow::anyhow!("读取截图文件失败: {}", e))?;

    // 5. 执行 OCR
    let result = {
        let eng = engine.lock().await;
        eng.recognize(&image_buffer)?
    };

    // 6. 清洗文本
    let cleaner = get_ocr_text_cleaner();
    let clean_result = cleaner.clean(&result.text);
    let summary = if clean_result.cleaned_text.len() > OCR_SUMMARY_MAX_LENGTH {
        clean_result.cleaned_text[..OCR_SUMMARY_MAX_LENGTH].to_string()
    } else {
        clean_result.cleaned_text.clone()
    };

    // 7. 判断状态
    let source_status = if clean_result.cleaned_text.is_empty() {
        SourceStatus::NoText
    } else {
        SourceStatus::OcrDone
    };

    // 8. 来源质量
    let source_quality = if source_status == SourceStatus::NoText {
        SourceQuality::Low
    } else if clean_result.noise_score > 0.7 {
        SourceQuality::Low
    } else if clean_result.noise_score > 0.4 {
        SourceQuality::Medium
    } else if result.confidence >= 0.85 {
        SourceQuality::High
    } else if result.confidence >= 0.55 {
        SourceQuality::Medium
    } else {
        SourceQuality::Low
    };

    // 9. 构造 OcrBlock 数组
    let ocr_blocks: Vec<crate::models::OcrBlock> = result
        .boxes
        .iter()
        .map(|b| crate::models::OcrBlock {
            text: b.text.clone(),
            box_rect: crate::models::OcrBox {
                x: b.bounds.x as f64,
                y: b.bounds.y as f64,
                w: b.bounds.width as f64,
                h: b.bounds.height as f64,
            },
            confidence: b.confidence,
        })
        .collect();

    // 10. 更新 Segment
    let mut patch = WorkSegment::default();
    patch.ocr_text = clean_result.cleaned_text.clone();
    patch.ocr_summary = summary;
    patch.source_status = source_status;
    patch.ocr_blocks = ocr_blocks;
    patch.ocr_confidence = result.confidence;
    patch.source_quality = source_quality;
    patch.noise_score = Some(clean_result.noise_score);
    SegmentRepository::update(segment_id, patch)?;

    // 11. 删除临时截图（若未开启保存）
    let save_screenshots = config.lock().await.save_screenshots;
    if !save_screenshots {
        crate::capture::screenshot::delete_temp_screenshot(&screenshot_path);
    }

    Ok(())
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_ocr_queue_config_default() {
        let config = OcrQueueConfig::default();
        assert!(!config.save_screenshots);
        assert_eq!(config.concurrency, 1);
        assert_eq!(config.idle_release_ms, 10000);
    }

    #[tokio::test]
    async fn test_ocr_queue_enqueue_dedup() {
        let engine = WindowsOcrEngine::new();
        let queue = OcrQueue::new(engine, OcrQueueConfig::default());
        queue.enqueue("seg-1".to_string()).await;
        queue.enqueue("seg-1".to_string()).await; // 重复
        queue.enqueue("seg-2".to_string()).await;
        let size = queue.get_queue_size().await;
        assert_eq!(size, 2);
    }

    #[tokio::test]
    async fn test_ocr_queue_is_empty() {
        let engine = WindowsOcrEngine::new();
        let queue = OcrQueue::new(engine, OcrQueueConfig::default());
        assert!(queue.is_empty().await);
        queue.enqueue("seg-1".to_string()).await;
        assert!(!queue.is_empty().await);
    }

    #[tokio::test]
    async fn test_ocr_queue_update_config() {
        let engine = WindowsOcrEngine::new();
        let queue = OcrQueue::new(engine, OcrQueueConfig::default());
        queue
            .update_config(OcrQueueConfig {
                save_screenshots: true,
                concurrency: 2,
                idle_release_ms: 5000,
            })
            .await;
        let config = queue.config.lock().await;
        assert!(config.save_screenshots);
        assert_eq!(config.concurrency, 2);
        assert_eq!(config.idle_release_ms, 5000);
    }
}
