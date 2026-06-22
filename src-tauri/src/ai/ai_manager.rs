//! AiManager：AI 编排层单例（对应 electron/ai/AiManager.ts）
//!
//! 职责：
//!  - initialize()：初始化（预留扩展点）
//!  - generate_report()：调 ReportGenerator 生成日报，结果存入 ReportRepository
//!  - test_connection()：测试 API 连接
//!  - get_status()：获取 AI 模块运行状态
//!  - stop()：停止管理器
//!
//! 与 TypeScript 版本的差异：
//!  - 不实现 estimateChars / exportMarkdown / exportWord / exportJson（由 ReportGenerator / ReportExporter 直接提供）
//!  - 新增 get_status() 方法返回 AiStatus 结构体

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use anyhow::Result;
use once_cell::sync::Lazy;

use crate::ai::report_generator::ReportGenerator;
use crate::models::{Report, ReportTemplate};
use crate::repositories::settings_store::SettingsStore;

/// AI 模块运行状态
#[derive(Debug, Clone)]
pub struct AiStatus {
    /// 是否已初始化
    pub running: bool,
    /// 当前配置的模型名
    pub model: String,
    /// 是否已配置 API Key
    pub api_configured: bool,
}

/// AiManager：AI 编排层
pub struct AiManager {
    initialized: AtomicBool,
    report_generator: ReportGenerator,
}

impl AiManager {
    pub fn new() -> Self {
        AiManager {
            initialized: AtomicBool::new(false),
            report_generator: ReportGenerator::new(),
        }
    }

    /// 初始化（app ready 后调用，当前无特殊初始化逻辑，预留扩展点）
    pub fn initialize(&self) -> Result<()> {
        if self.initialized.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.initialized.store(true, Ordering::SeqCst);
        log::info!("[AiManager] 初始化完成");
        Ok(())
    }

    /// 获取 AI 模块运行状态
    pub fn get_status(&self) -> AiStatus {
        let settings = SettingsStore::get();
        AiStatus {
            running: self.initialized.load(Ordering::SeqCst),
            model: settings.model_name,
            api_configured: !SettingsStore::get_api_key().is_empty(),
        }
    }

    /// 生成日报并保存到数据库。
    ///
    /// # 参数
    /// - `date`：日期 YYYY-MM-DD
    /// - `template`：报告模板
    /// - `user_notes`：用户备注
    ///
    /// # 返回
    /// 已保存的 Report 对象（status='draft'）
    pub async fn generate_report(
        &self,
        date: &str,
        template: ReportTemplate,
        user_notes: &str,
    ) -> Result<Report> {
        self.report_generator
            .generate_and_save(date, template, user_notes)
            .await
    }

    /// 测试 API 连接（发送一个极简 ping 请求）。
    pub async fn test_connection(&self) -> Result<bool> {
        self.report_generator.test_connection().await
    }

    /// 停止管理器
    pub fn stop(&self) {
        self.initialized.store(false, Ordering::SeqCst);
        log::info!("[AiManager] 已停止");
    }
}

impl Default for AiManager {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单例 =====================

/// AiManager 全局单例
static AI_MANAGER: Lazy<Mutex<AiManager>> = Lazy::new(|| Mutex::new(AiManager::new()));

/// 获取 AiManager 单例（Mutex 守卫）
pub fn get_ai_manager() -> &'static Mutex<AiManager> {
    &AI_MANAGER
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试 AiManager 创建
    #[test]
    fn test_ai_manager_new() {
        let manager = AiManager::new();
        let status = manager.get_status();
        assert!(!status.running);
    }

    /// 测试 initialize
    #[test]
    fn test_initialize() {
        let manager = AiManager::new();
        assert!(manager.initialize().is_ok());
        let status = manager.get_status();
        assert!(status.running);
        // 重复初始化不应报错
        assert!(manager.initialize().is_ok());
    }

    /// 测试 stop
    #[test]
    fn test_stop() {
        let manager = AiManager::new();
        manager.initialize().ok();
        assert!(manager.get_status().running);
        manager.stop();
        assert!(!manager.get_status().running);
    }

    /// 测试 get_status 返回结构
    #[test]
    fn test_get_status() {
        let manager = AiManager::new();
        let status = manager.get_status();
        // model 字段应为非空字符串（默认值 gpt-4o-mini）
        assert!(!status.model.is_empty());
    }
}
