//! mem_cell_indexer：MemCell 语义向量索引器（对应 electron/memory/MemCellIndexer.ts）
//!
//! 职责：
//!  - 监听事件总线上的 `MemCellCreated` 事件，异步为新建 MemCell 生成 embedding 并存储
//!  - 提供 `index(mem_cell_id, text)` 同步索引接口
//!  - 错误隔离：embedding 生成失败不阻塞主流程，仅记录日志
//!
//! 设计说明：
//!  - 通过事件总线解耦：DistillManager 不直接调用 MemCellIndexer，仅 publish 事件
//!  - 异步处理：事件监听任务内部 catch 异常，不影响事件发射方
//!  - 当前 EmbeddingService 为 stub，索引会失败但不会 panic，待 ort 启用后即可工作

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::broadcast;

use crate::events::bus::{AppEvent, EventBus};
use crate::memory::embedding_service::EmbeddingService;
use crate::models::MemCell;
use crate::repositories::embedding_repository::EmbeddingRepository;
use crate::repositories::mem_cell_repository::MemCellRepository;

/// MemCellIndexer：MemCell 语义向量索引器
///
/// 使用方式：
/// ```rust,ignore
/// let indexer = MemCellIndexer::new();
/// indexer.start_indexing();  // app ready 后调用，启动事件监听
/// // ... DistillManager 写入 MemCell 后会自动触发索引
/// indexer.stop_indexing();   // app 退出前调用
/// ```
pub struct MemCellIndexer {
    /// 是否正在运行（已启动事件监听）
    running: Arc<AtomicBool>,
    /// 后台监听任务的 JoinHandle（停止时用于 abort）
    task_handle: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl MemCellIndexer {
    /// 创建索引器实例
    pub fn new() -> Self {
        MemCellIndexer {
            running: Arc::new(AtomicBool::new(false)),
            task_handle: tokio::sync::Mutex::new(None),
        }
    }

    /// 是否正在运行（已启动事件监听）
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 开始监听 `MemCellCreated` 事件
    ///
    /// 启动一个 tokio 任务订阅事件总线，收到事件后调用 `index` 异步生成 embedding。
    /// 重复调用安全：若已在运行则直接返回。
    pub async fn start_indexing(self: &Arc<Self>) {
        if self.running.swap(true, Ordering::SeqCst) {
            // 已在运行
            return;
        }

        let self_clone = Arc::clone(self);
        let mut rx = EventBus::subscribe();

        let handle = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        if let AppEvent::MemCellCreated { mem_cell_id } = event {
                            // 错误隔离：index 内部 catch 异常，不影响监听循环
                            if let Err(e) = self_clone.index_by_id(&mem_cell_id) {
                                log::error!(
                                    "[MemCellIndexer] 事件监听索引失败 (mem_cell_id={}): {}",
                                    mem_cell_id,
                                    e
                                );
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        // 通道关闭，退出监听
                        self_clone.running.store(false, Ordering::SeqCst);
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // 订阅者 lag，丢弃旧消息，继续监听
                        continue;
                    }
                }
            }
        });

        let mut guard = self.task_handle.lock().await;
        *guard = Some(handle);
    }

    /// 停止监听 `MemCellCreated` 事件
    pub async fn stop_indexing(&self) {
        self.running.store(false, Ordering::SeqCst);
        let mut guard = self.task_handle.lock().await;
        if let Some(handle) = guard.take() {
            handle.abort();
        }
    }

    /// 索引单个 MemCell：根据 mem_cell_id 查询 MemCell，生成 embedding 并存储
    ///
    /// 错误隔离：内部 try-catch 包裹，失败时仅记录日志并返回 Err，
    /// 调用方应处理错误（如事件监听器会记录日志后继续运行）。
    pub fn index_by_id(&self, mem_cell_id: &str) -> anyhow::Result<()> {
        // 1. 查询 MemCell
        let mem_cell = MemCellRepository::get_by_id(mem_cell_id)?
            .ok_or_else(|| anyhow::anyhow!("MemCell {} 不存在", mem_cell_id))?;

        // 2. 构造 embedding 输入文本
        let text = mem_cell.build_embedding_text();

        // 3. 调用 EmbeddingService 生成 embedding（stub 模式会返回错误）
        let service = EmbeddingService::new();
        let embedding = service.embed(&text)?;

        // 4. 存储到 EmbeddingRepository
        EmbeddingRepository::insert(
            mem_cell_id,
            &embedding,
            service.get_model_version(),
        )?;

        Ok(())
    }

    /// 索引接口：根据 mem_cell_id 与文本直接生成 embedding 并存储
    ///
    /// 与 `index_by_id` 的区别：跳过 MemCellRepository 查询，直接使用调用方提供的文本。
    /// 适用于测试或调用方已持有文本的场景。
    pub fn index(&self, mem_cell_id: &str, text: &str) -> anyhow::Result<()> {
        let service = EmbeddingService::new();
        let embedding = service.embed(text)?;
        EmbeddingRepository::insert(mem_cell_id, &embedding, service.get_model_version())?;
        Ok(())
    }

    /// 索引已有 MemCell 实例：直接使用其字段构造文本
    ///
    /// 与 `index_by_id` 的区别：跳过数据库查询，直接使用调用方提供的 MemCell。
    pub fn index_mem_cell(&self, mem_cell: &MemCell) -> anyhow::Result<()> {
        let text = mem_cell.build_embedding_text();
        self.index(&mem_cell.id, &text)
    }
}

impl Default for MemCellIndexer {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::mem_cell::MemCellBuilder;

    #[test]
    fn test_new_indexer_not_running() {
        let indexer = MemCellIndexer::new();
        // 新建的索引器不应处于运行状态
        assert!(!indexer.is_running());
    }

    #[test]
    fn test_index_returns_error_when_service_unavailable() {
        // 当前 EmbeddingService 为 stub，index 应返回错误（但不 panic）
        // 注意：此测试不依赖数据库，因为 EmbeddingService::embed 在调用数据库前就会失败
        let indexer = MemCellIndexer::new();
        let result = indexer.index("test-cell-id", "前端组件开发");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("not available"),
            "错误信息应包含 not available，实际: {}",
            err
        );
    }

    #[test]
    fn test_index_mem_cell_uses_episode_and_facts() {
        // 验证 index_mem_cell 会调用 EmbeddingService（stub 模式下返回错误）
        let cell = MemCellBuilder::new()
            .id("cell-test")
            .episode("测试 episode")
            .fact("事实1")
            .build();

        let indexer = MemCellIndexer::new();
        let result = indexer.index_mem_cell(&cell);
        // stub 模式下应返回错误
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_start_and_stop_indexing() {
        let indexer = Arc::new(MemCellIndexer::new());
        // 启动监听
        indexer.start_indexing().await;
        assert!(indexer.is_running());

        // 停止监听
        indexer.stop_indexing().await;
        // 给任务一点时间真正退出
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        assert!(!indexer.is_running());
    }

    #[tokio::test]
    async fn test_start_indexing_idempotent() {
        let indexer = Arc::new(MemCellIndexer::new());
        indexer.start_indexing().await;
        // 重复启动应安全（不 panic，不创建多个任务）
        indexer.start_indexing().await;
        assert!(indexer.is_running());

        indexer.stop_indexing().await;
    }
}
