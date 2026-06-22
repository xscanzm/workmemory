/**
 * EventBus：共享事件总线（Rust 实现）
 *
 * 基于 `tokio::sync::broadcast` 的进程内事件中心，用于解耦生产者与消费者。
 *
 * 当前事件：
 *  - SegmentCreated：CaptureManager 创建新 Segment 后发布
 *  - SegmentMerged：CaptureDecision 合并 Segment 后发布
 *  - PrivacyPlaceholder：PrivacyGuard 触发隐私占位后发布
 *  - StateChange：CaptureDecision 状态切换后发布
 *  - OcrCompleted：OcrQueue 完成 OCR 后发布
 *  - OcrFailed：OcrQueue OCR 失败后发布
 *  - EpisodesRebuilt：EpisodeManager/EpisodeBuilder 重建 Episode 后发布
 *  - MemCellCreated：DistillManager 写入 MemCell 后发布，
 *    MemCellIndexer 监听该事件异步生成 embedding 并存储到 embeddings 表。
 *
 * 设计说明：
 *  - 生产者不直接持有消费者引用，避免循环依赖与初始化顺序问题。
 *  - 失败不阻塞：事件发布是异步的，消费者内部处理任何异常，不影响生产者主流程。
 *  - 使用 broadcast 通道支持多订阅者；订阅者 lag 时丢弃旧消息（容量 256）。
 */
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// 事件总线容量（广播通道缓冲区大小）
const EVENT_BUS_CAPACITY: usize = 256;

/// 应用事件类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppEvent {
    /// Segment 创建完成
    /// payload: { segment_id }
    SegmentCreated { segment_id: String },
    /// Segment 合并完成
    /// payload: { segment_id }
    SegmentMerged { segment_id: String },
    /// 隐私占位触发
    /// payload: { segment_id }
    PrivacyPlaceholder { segment_id: String },
    /// 捕获状态切换
    /// payload: { state }
    StateChange { state: String },
    /// OCR 完成
    /// payload: { segment_id }
    OcrCompleted { segment_id: String },
    /// OCR 失败
    /// payload: { segment_id, error }
    OcrFailed { segment_id: String, error: String },
    /// Episode 重建完成
    /// payload: { date }
    EpisodesRebuilt { date: String },
    /// MemCell 创建完成
    /// payload: { mem_cell_id }
    MemCellCreated { mem_cell_id: String },
}

/// 共享事件总线单例
///
/// 使用方式：
/// ```rust,ignore
/// // 订阅
/// let mut rx = EventBus::subscribe();
/// while let Ok(event) = rx.recv().await {
///     match event {
///         AppEvent::MemCellCreated { mem_cell_id } => { /* ... */ }
///         _ => {}
///     }
/// }
///
/// // 发布
/// EventBus::publish(AppEvent::MemCellCreated { mem_cell_id: "xxx".into() });
/// ```
pub struct EventBus;

static EVENT_SENDER: once_cell::sync::Lazy<broadcast::Sender<AppEvent>> =
    once_cell::sync::Lazy::new(|| {
        let (tx, _rx) = broadcast::channel(EVENT_BUS_CAPACITY);
        tx
    });

impl EventBus {
    /// 发布事件到所有订阅者
    ///
    /// 如果没有订阅者或订阅者 lag，事件被丢弃（不阻塞发布者）。
    pub fn publish(event: AppEvent) {
        // send 失败表示没有订阅者，这是正常情况
        let _ = EVENT_SENDER.send(event);
    }

    /// 订阅事件流
    ///
    /// 返回 broadcast::Receiver，调用 `recv().await` 接收事件。
    /// 订阅后只能收到新事件，不会收到历史事件。
    pub fn subscribe() -> broadcast::Receiver<AppEvent> {
        EVENT_SENDER.subscribe()
    }

    /// 获取当前订阅者数量
    pub fn subscriber_count() -> usize {
        EVENT_SENDER.receiver_count()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{timeout, Duration};

    #[tokio::test]
    async fn test_publish_subscribe_single() {
        let mut rx = EventBus::subscribe();
        EventBus::publish(AppEvent::OcrCompleted {
            segment_id: "seg-1".to_string(),
        });
        let event = timeout(Duration::from_millis(500), rx.recv())
            .await
            .expect("超时")
            .expect("接收失败");
        match event {
            AppEvent::OcrCompleted { segment_id } => {
                assert_eq!(segment_id, "seg-1");
            }
            _ => panic!("期望 OcrCompleted 事件"),
        }
    }

    #[tokio::test]
    async fn test_multiple_subscribers() {
        let mut rx1 = EventBus::subscribe();
        let mut rx2 = EventBus::subscribe();
        EventBus::publish(AppEvent::SegmentCreated {
            segment_id: "seg-2".to_string(),
        });
        let e1 = timeout(Duration::from_millis(500), rx1.recv())
            .await
            .expect("rx1 超时")
            .expect("rx1 接收失败");
        let e2 = timeout(Duration::from_millis(500), rx2.recv())
            .await
            .expect("rx2 超时")
            .expect("rx2 接收失败");
        match (e1, e2) {
            (AppEvent::SegmentCreated { segment_id: id1 }, AppEvent::SegmentCreated { segment_id: id2 }) => {
                assert_eq!(id1, "seg-2");
                assert_eq!(id2, "seg-2");
            }
            _ => panic!("期望 SegmentCreated 事件"),
        }
    }

    #[tokio::test]
    async fn test_publish_without_subscribers() {
        // 无订阅者时发布不应 panic
        EventBus::publish(AppEvent::StateChange {
            state: "idle".to_string(),
        });
    }

    #[tokio::test]
    async fn test_all_event_variants() {
        let mut rx = EventBus::subscribe();
        let events = vec![
            AppEvent::SegmentCreated { segment_id: "s1".into() },
            AppEvent::SegmentMerged { segment_id: "s2".into() },
            AppEvent::PrivacyPlaceholder { segment_id: "s3".into() },
            AppEvent::StateChange { state: "recording".into() },
            AppEvent::OcrCompleted { segment_id: "s4".into() },
            AppEvent::OcrFailed { segment_id: "s5".into(), error: "test".into() },
            AppEvent::EpisodesRebuilt { date: "2026-06-22".into() },
            AppEvent::MemCellCreated { mem_cell_id: "m1".into() },
        ];
        let count = events.len();
        for event in events {
            EventBus::publish(event);
        }
        let mut received = 0;
        for _ in 0..count {
            let event = timeout(Duration::from_millis(500), rx.recv())
                .await
                .expect("超时")
                .expect("接收失败");
            // 验证可序列化
            let json = serde_json::to_string(&event).expect("序列化失败");
            assert!(!json.is_empty());
            received += 1;
        }
        assert_eq!(received, count);
    }

    #[test]
    fn test_event_serialization() {
        let event = AppEvent::OcrFailed {
            segment_id: "seg-123".to_string(),
            error: "识别失败".to_string(),
        };
        let json = serde_json::to_string(&event).expect("序列化失败");
        assert!(json.contains("ocr_failed"));
        assert!(json.contains("seg-123"));
        assert!(json.contains("识别失败"));

        let deserialized: AppEvent = serde_json::from_str(&json).expect("反序列化失败");
        match deserialized {
            AppEvent::OcrFailed { segment_id, error } => {
                assert_eq!(segment_id, "seg-123");
                assert_eq!(error, "识别失败");
            }
            _ => panic!("期望 OcrFailed 事件"),
        }
    }

    #[test]
    fn test_subscriber_count() {
        let _rx1 = EventBus::subscribe();
        let _rx2 = EventBus::subscribe();
        let count = EventBus::subscriber_count();
        assert!(count >= 2);
    }
}
