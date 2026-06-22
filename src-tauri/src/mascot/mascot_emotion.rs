//! MascotEmotion：桌面伙伴情绪状态机（spec M13.4）
//!
//! 根据用户行为事件驱动 Mascot 的情绪切换：
//!  - 报告生成 → Happy
//!  - 长时间专注 → Focused（>20 分钟）/ Concerned（>120 分钟，提醒休息）
//!  - 检测到新应用 → Curious
//!  - 目标完成 → Proud
//!  - 夜间 / 空闲 → Sleepy
//!
//! 情绪状态独立于 MascotState（记录状态），仅用于表情/动画切换。

use serde::{Deserialize, Serialize};

// ===================== 枚举类型 =====================

/// Mascot 情绪类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MascotEmotion {
    /// 开心：报告生成、目标完成
    Happy,
    /// 专注：长时间聚焦
    Focused,
    /// 担心：过长时间未休息
    Concerned,
    /// 好奇：检测到新应用
    Curious,
    /// 自豪：完成目标
    Proud,
    /// 困倦：夜间或长时间空闲
    Sleepy,
}

impl Default for MascotEmotion {
    fn default() -> Self {
        MascotEmotion::Happy
    }
}

impl MascotEmotion {
    pub fn as_str(&self) -> &'static str {
        match self {
            MascotEmotion::Happy => "happy",
            MascotEmotion::Focused => "focused",
            MascotEmotion::Concerned => "concerned",
            MascotEmotion::Curious => "curious",
            MascotEmotion::Proud => "proud",
            MascotEmotion::Sleepy => "sleepy",
        }
    }
}

/// 触发情绪切换的事件
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmotionEvent {
    /// 报告已生成
    ReportGenerated,
    /// 持续专注 N 分钟
    LongFocus { minutes: u32 },
    /// 检测到新应用
    NewAppDetected,
    /// 目标已完成
    GoalCompleted,
    /// 进入夜间
    NightTime,
    /// 空闲
    Idle,
}

// ===================== 状态机 =====================

/// 情绪状态机：维护当前情绪并根据事件切换
pub struct EmotionStateMachine {
    /// 当前情绪
    current: MascotEmotion,
}

impl EmotionStateMachine {
    /// 创建情绪状态机，默认情绪 Happy
    pub fn new() -> Self {
        Self {
            current: MascotEmotion::Happy,
        }
    }

    /// 直接设置情绪
    pub fn set_emotion(&mut self, emotion: MascotEmotion) {
        self.current = emotion;
    }

    /// 获取当前情绪
    pub fn get_emotion(&self) -> MascotEmotion {
        self.current
    }

    /// 处理事件并按规则切换情绪
    pub fn on_event(&mut self, event: EmotionEvent) {
        let next = match event {
            EmotionEvent::ReportGenerated => MascotEmotion::Happy,
            EmotionEvent::LongFocus { minutes } => {
                if minutes > 120 {
                    // 超过 120 分钟未休息，切换为担心
                    MascotEmotion::Concerned
                } else if minutes > 20 {
                    // 超过 20 分钟持续专注
                    MascotEmotion::Focused
                } else {
                    // 未达阈值，保持当前情绪
                    return;
                }
            }
            EmotionEvent::NewAppDetected => MascotEmotion::Curious,
            EmotionEvent::GoalCompleted => MascotEmotion::Proud,
            EmotionEvent::NightTime => MascotEmotion::Sleepy,
            EmotionEvent::Idle => MascotEmotion::Sleepy,
        };
        self.current = next;
    }
}

impl Default for EmotionStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_emotion_is_happy() {
        let sm = EmotionStateMachine::new();
        assert_eq!(sm.get_emotion(), MascotEmotion::Happy);
    }

    #[test]
    fn test_report_generated_to_happy() {
        let mut sm = EmotionStateMachine::new();
        sm.set_emotion(MascotEmotion::Sleepy);
        sm.on_event(EmotionEvent::ReportGenerated);
        assert_eq!(sm.get_emotion(), MascotEmotion::Happy);
    }

    #[test]
    fn test_long_focus_thresholds() {
        let mut sm = EmotionStateMachine::new();
        // 10 分钟：未达阈值，保持原情绪
        sm.set_emotion(MascotEmotion::Curious);
        sm.on_event(EmotionEvent::LongFocus { minutes: 10 });
        assert_eq!(sm.get_emotion(), MascotEmotion::Curious);

        // 25 分钟：切换为 Focused
        sm.on_event(EmotionEvent::LongFocus { minutes: 25 });
        assert_eq!(sm.get_emotion(), MascotEmotion::Focused);

        // 150 分钟：切换为 Concerned
        sm.on_event(EmotionEvent::LongFocus { minutes: 150 });
        assert_eq!(sm.get_emotion(), MascotEmotion::Concerned);
    }

    #[test]
    fn test_long_focus_boundary_values() {
        let mut sm = EmotionStateMachine::new();
        // 恰好 20 分钟：未达 >20 阈值，保持
        sm.set_emotion(MascotEmotion::Happy);
        sm.on_event(EmotionEvent::LongFocus { minutes: 20 });
        assert_eq!(sm.get_emotion(), MascotEmotion::Happy);

        // 恰好 21 分钟：切换为 Focused
        sm.on_event(EmotionEvent::LongFocus { minutes: 21 });
        assert_eq!(sm.get_emotion(), MascotEmotion::Focused);

        // 恰好 120 分钟：未达 >120 阈值，保持 Focused
        sm.on_event(EmotionEvent::LongFocus { minutes: 120 });
        assert_eq!(sm.get_emotion(), MascotEmotion::Focused);

        // 恰好 121 分钟：切换为 Concerned
        sm.on_event(EmotionEvent::LongFocus { minutes: 121 });
        assert_eq!(sm.get_emotion(), MascotEmotion::Concerned);
    }

    #[test]
    fn test_new_app_detected_to_curious() {
        let mut sm = EmotionStateMachine::new();
        sm.on_event(EmotionEvent::NewAppDetected);
        assert_eq!(sm.get_emotion(), MascotEmotion::Curious);
    }

    #[test]
    fn test_goal_completed_to_proud() {
        let mut sm = EmotionStateMachine::new();
        sm.on_event(EmotionEvent::GoalCompleted);
        assert_eq!(sm.get_emotion(), MascotEmotion::Proud);
    }

    #[test]
    fn test_night_and_idle_to_sleepy() {
        let mut sm = EmotionStateMachine::new();
        sm.on_event(EmotionEvent::NightTime);
        assert_eq!(sm.get_emotion(), MascotEmotion::Sleepy);

        // 切换到其他情绪后再触发 Idle
        sm.set_emotion(MascotEmotion::Happy);
        sm.on_event(EmotionEvent::Idle);
        assert_eq!(sm.get_emotion(), MascotEmotion::Sleepy);
    }

    #[test]
    fn test_set_emotion_directly() {
        let mut sm = EmotionStateMachine::new();
        sm.set_emotion(MascotEmotion::Proud);
        assert_eq!(sm.get_emotion(), MascotEmotion::Proud);
    }

    #[test]
    fn test_emotion_as_str() {
        assert_eq!(MascotEmotion::Happy.as_str(), "happy");
        assert_eq!(MascotEmotion::Focused.as_str(), "focused");
        assert_eq!(MascotEmotion::Concerned.as_str(), "concerned");
        assert_eq!(MascotEmotion::Curious.as_str(), "curious");
        assert_eq!(MascotEmotion::Proud.as_str(), "proud");
        assert_eq!(MascotEmotion::Sleepy.as_str(), "sleepy");
    }
}
