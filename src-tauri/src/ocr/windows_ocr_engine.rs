//! Windows OCR 引擎实现
//!
//! 基于 Windows.Media.Ocr API 实现本地 OCR 识别。
//! 在非 Windows 平台上提供 stub 实现，返回不可用状态。
//!
//! 对应规格 T3.1：使用 windows crate 的 Media::Ocr API 进行文本识别。

use crate::models::BoundsRect;
use serde::{Deserialize, Serialize};

/// OCR 识别结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrResult {
    /// 识别出的全文（多行用 \n 分隔）
    pub text: String,
    /// 文本框列表
    pub boxes: Vec<OcrBox>,
    /// 整体置信度（Windows OCR 不提供置信度，固定为 1.0）
    pub confidence: f64,
    /// 识别耗时（毫秒）
    pub elapsed_ms: u64,
}

/// OCR 单个文本框
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrBox {
    /// 文本内容
    pub text: String,
    /// 边界矩形（复用 models::BoundsRect）
    pub bounds: BoundsRect,
    /// 置信度（Windows OCR 不提供词级置信度，固定为 1.0）
    pub confidence: f64,
}

// ===================== Windows 平台实现 =====================

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{OcrBox, OcrResult};
    use crate::models::BoundsRect;
    use windows::core::Interface;
    use windows::foundation::Rect;
    use windows::graphics::imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::media::ocr::OcrEngine;
    use windows::storage::streams::DataWriter;

    /// Windows OCR 引擎
    ///
    /// 封装 windows::Media::Ocr::OcrEngine，提供同步的 OCR 识别接口。
    pub struct WindowsOcrEngine {
        engine: Option<OcrEngine>,
    }

    impl WindowsOcrEngine {
        /// 创建新的 OCR 引擎实例（未初始化状态）
        pub fn new() -> Self {
            WindowsOcrEngine { engine: None }
        }

        /// 初始化 OCR 引擎
        ///
        /// 使用 `OcrEngine::TryCreateFromUserProfileLanguages()` 创建引擎。
        /// 若返回 None（用户未配置 OCR 语言），则进入"未配置"状态，不报错。
        pub fn initialize(&mut self) -> anyhow::Result<()> {
            match OcrEngine::TryCreateFromUserProfileLanguages() {
                Ok(engine) => {
                    self.engine = Some(engine);
                    log::info!("Windows OCR 引擎初始化成功");
                    Ok(())
                }
                Err(e) => {
                    // 未配置状态，不报错
                    log::warn!("Windows OCR 引擎未配置（用户语言不可用）: {}", e);
                    self.engine = None;
                    Ok(())
                }
            }
        }

        /// 识别图像中的文本
        ///
        /// 流程：解码 PNG → SoftwareBitmap::CreateCopyFromBuffer → engine.RecognizeAsync → 提取结果
        pub fn recognize(&self, image_buffer: &[u8]) -> anyhow::Result<OcrResult> {
            let engine = self
                .engine
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("OCR 引擎未初始化，请先调用 initialize()"))?;

            let start = std::time::Instant::now();

            // 解码图像（PNG/JPEG 等），转换为 RGBA8 像素数据
            let img = image::load_from_memory(image_buffer)
                .map_err(|e| anyhow::anyhow!("图像解码失败: {}", e))?;
            let rgba = img.to_rgba8();
            let (width, height) = rgba.dimensions();
            let pixel_data = rgba.into_raw();

            // 通过 DataWriter 创建 IBuffer
            let data_writer = DataWriter::CreateDataWriter()
                .map_err(|e| anyhow::anyhow!("创建 DataWriter 失败: {}", e))?;
            data_writer
                .WriteBytes(&pixel_data)
                .map_err(|e| anyhow::anyhow!("写入像素数据失败: {}", e))?;
            let buffer = data_writer
                .DetachBuffer()
                .map_err(|e| anyhow::anyhow!("分离 Buffer 失败: {}", e))?;

            // 创建 SoftwareBitmap（RGBA8 格式）
            let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
                &buffer,
                BitmapPixelFormat::Rgba8,
                width as i32,
                height as i32,
                BitmapAlphaMode::Premultiplied,
            )
            .map_err(|e| anyhow::anyhow!("创建 SoftwareBitmap 失败: {}", e))?;

            // 执行 OCR 识别，同步等待 IAsyncOperation 完成
            let async_op = engine
                .RecognizeAsync(&bitmap)
                .map_err(|e| anyhow::anyhow!("启动 OCR 识别失败: {}", e))?;
            let result = async_op
                .get()
                .map_err(|e| anyhow::anyhow!("OCR 识别失败: {}", e))?;

            // 拼接所有行的文本（用 \n 分隔）
            let text = result
                .Lines()
                .iter()
                .map(|l| l.Text().to_string())
                .collect::<Vec<_>>()
                .join("\n");

            // 提取所有词的边界框
            let boxes = result
                .Lines()
                .iter()
                .flat_map(|l| l.Words())
                .map(|w| {
                    let rect: Rect = w.BoundingRect();
                    OcrBox {
                        text: w.Text().to_string(),
                        bounds: BoundsRect {
                            x: rect.X as i32,
                            y: rect.Y as i32,
                            width: rect.Width as i32,
                            height: rect.Height as i32,
                        },
                        confidence: 1.0,
                    }
                })
                .collect();

            let elapsed_ms = start.elapsed().as_millis() as u64;

            Ok(OcrResult {
                text,
                boxes,
                confidence: 1.0,
                elapsed_ms,
            })
        }

        /// 引擎是否可用（已初始化且引擎存在）
        pub fn is_available(&self) -> bool {
            self.engine.is_some()
        }

        /// 释放引擎资源
        pub fn release(&mut self) {
            self.engine = None;
        }
    }

    impl Default for WindowsOcrEngine {
        fn default() -> Self {
            Self::new()
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::WindowsOcrEngine;

// ===================== 非 Windows 平台 stub 实现 =====================

#[cfg(not(target_os = "windows"))]
mod stub_impl {
    use super::OcrResult;

    /// Windows OCR 引擎（非 Windows 平台 stub）
    ///
    /// 在非 Windows 平台上提供占位实现，`is_available()` 始终返回 false，
    /// `recognize()` 始终返回错误。
    pub struct WindowsOcrEngine;

    impl WindowsOcrEngine {
        /// 创建新的 OCR 引擎实例（stub）
        pub fn new() -> Self {
            WindowsOcrEngine
        }

        /// 初始化 OCR 引擎（stub，无操作，始终成功）
        pub fn initialize(&mut self) -> anyhow::Result<()> {
            Ok(())
        }

        /// 识别图像中的文本（stub，始终返回错误）
        pub fn recognize(&self, _image_buffer: &[u8]) -> anyhow::Result<OcrResult> {
            Err(anyhow::anyhow!(
                "Windows OCR 引擎在非 Windows 平台不可用"
            ))
        }

        /// 引擎是否可用（stub，始终返回 false）
        pub fn is_available(&self) -> bool {
            false
        }

        /// 释放引擎资源（stub，无操作）
        pub fn release(&mut self) {}
    }

    impl Default for WindowsOcrEngine {
        fn default() -> Self {
            Self::new()
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub use stub_impl::WindowsOcrEngine;

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试 OcrResult 序列化/反序列化
    #[test]
    fn test_ocr_result_serialization() {
        let result = OcrResult {
            text: "你好\n世界".to_string(),
            boxes: vec![],
            confidence: 1.0,
            elapsed_ms: 42,
        };
        let json = serde_json::to_string(&result).expect("序列化失败");
        let deserialized: OcrResult = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(result.text, deserialized.text);
        assert_eq!(result.confidence, deserialized.confidence);
        assert_eq!(result.elapsed_ms, deserialized.elapsed_ms);
        assert!(deserialized.boxes.is_empty());
    }

    /// 测试 OcrBox 序列化/反序列化（含 BoundsRect）
    #[test]
    fn test_ocr_box_serialization() {
        let ocr_box = OcrBox {
            text: "hello".to_string(),
            bounds: BoundsRect {
                x: 10,
                y: 20,
                width: 100,
                height: 30,
            },
            confidence: 1.0,
        };
        let json = serde_json::to_string(&ocr_box).expect("序列化失败");
        let deserialized: OcrBox = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(ocr_box.text, deserialized.text);
        assert_eq!(ocr_box.bounds.x, deserialized.bounds.x);
        assert_eq!(ocr_box.bounds.y, deserialized.bounds.y);
        assert_eq!(ocr_box.bounds.width, deserialized.bounds.width);
        assert_eq!(ocr_box.bounds.height, deserialized.bounds.height);
        assert_eq!(ocr_box.confidence, deserialized.confidence);
    }

    /// 测试非 Windows 平台 stub 行为
    #[test]
    fn test_stub_on_non_windows() {
        let engine = WindowsOcrEngine::new();
        // 非 Windows 平台始终不可用
        assert!(!engine.is_available());

        // recognize 返回错误
        let result = engine.recognize(&[]);
        assert!(result.is_err());

        // initialize 不报错
        let mut engine = WindowsOcrEngine::new();
        assert!(engine.initialize().is_ok());

        // release 不报错
        engine.release();
    }
}
