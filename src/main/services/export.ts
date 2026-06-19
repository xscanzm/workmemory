import fs from "fs";
import path from "path";
import { app, dialog } from "electron";

/**
 * ExportService - 导出服务
 * 支持 Markdown 导出、Word 导出（P0 基础）、富文本复制
 */
export class ExportService {
  /**
   * 导出 Markdown 文件
   */
  async exportMarkdown(
    content: string,
    defaultFilename: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const result = await dialog.showSaveDialog({
        title: "导出 Markdown",
        defaultPath: defaultFilename,
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: "已取消" };
      }

      fs.writeFileSync(result.filePath, content, "utf-8");
      return { success: true, filePath: result.filePath };
    } catch (error: any) {
      return { success: false, error: error?.message || "导出失败" };
    }
  }

  /**
   * 导出 Word 文件（P0 基础版：另存为 HTML 格式的 .doc）
   * P1 应使用 docx 库生成真正的 .docx
   */
  async exportWord(
    htmlContent: string,
    defaultFilename: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const result = await dialog.showSaveDialog({
        title: "导出 Word",
        defaultPath: defaultFilename,
        filters: [
          { name: "Word Document", extensions: ["doc"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: "已取消" };
      }

      const wordHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Microsoft YaHei', sans-serif; line-height: 1.8; padding: 20px; }
    h1 { font-size: 20px; }
    h2 { font-size: 16px; }
    h3 { font-size: 14px; }
    ul, ol { padding-left: 20px; }
    li { margin: 4px 0; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;

      fs.writeFileSync(result.filePath, wordHtml, "utf-8");
      return { success: true, filePath: result.filePath };
    } catch (error: any) {
      return { success: false, error: error?.message || "导出失败" };
    }
  }

  /**
   * 将 Markdown 转换为简单 HTML（用于富文本复制和 Word 导出）
   */
  markdownToHtml(markdown: string): string {
    let html = markdown;

    // Headers
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

    // Paragraphs
    html = html.replace(/\n\n/g, "</p><p>");
    html = "<p>" + html + "</p>";

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, "");
    html = html.replace(/<p><h/g, "<h");
    html = html.replace(/<\/h(\d)><\/p>/g, "</h$1>");
    html = html.replace(/<p><ul>/g, "<ul>");
    html = html.replace(/<\/ul><\/p>/g, "</ul>");

    return html;
  }
}

export const exportService = new ExportService();