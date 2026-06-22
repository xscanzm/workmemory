/**
 * events 模块：进程内事件总线
 *
 * Phase 2 T2.5：基于 tokio::sync::broadcast 的共享事件总线，
 * 用于解耦生产者与消费者（如 CaptureManager → EpisodeBuilder → InsightsManager）。
 */
pub mod bus;
