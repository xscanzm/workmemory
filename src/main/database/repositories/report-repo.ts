import { getDatabase, saveDatabase } from "../connection";
import { Report } from "../../../shared/types";
import { v4 as uuidv4 } from "uuid";

function queryAll(db: any, sql: string, params?: any[]): any[] {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(db: any, sql: string, params?: any[]): any | null {
  const rows = queryAll(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export class ReportRepository {
  async getAll(): Promise<Report[]> {
    const db = await getDatabase();
    const rows = queryAll(db, "SELECT * FROM reports ORDER BY created_at DESC");
    return rows.map(this.mapRow);
  }

  async getById(id: string): Promise<Report | null> {
    const db = await getDatabase();
    const row = queryOne(db, "SELECT * FROM reports WHERE id = ?", [id]);
    return row ? this.mapRow(row) : null;
  }

  async getByDate(date: string): Promise<Report[]> {
    const db = await getDatabase();
    const rows = queryAll(db, "SELECT * FROM reports WHERE date = ? ORDER BY created_at DESC", [date]);
    return rows.map(this.mapRow);
  }

  async save(report: Omit<Report, "id" | "createdAt" | "updatedAt">): Promise<Report> {
    const db = await getDatabase();
    const id = uuidv4();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO reports (
        id, date, template_id, template_name, segment_ids, user_notes,
        prompt_snapshot, ai_input_snapshot, markdown_content, rich_text_content,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, report.date, report.templateId, report.templateName,
        JSON.stringify(report.segmentIds), report.userNotes || null,
        report.promptSnapshot, report.aiInputSnapshot,
        report.markdownContent, report.richTextContent || null,
        report.status, now, now,
      ]
    );
    saveDatabase();
    return { ...report, id, createdAt: now, updatedAt: now };
  }

  async update(id: string, updates: Partial<Report>): Promise<void> {
    const db = await getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.templateName !== undefined) { fields.push("template_name = ?"); values.push(updates.templateName); }
    if (updates.segmentIds !== undefined) { fields.push("segment_ids = ?"); values.push(JSON.stringify(updates.segmentIds)); }
    if (updates.userNotes !== undefined) { fields.push("user_notes = ?"); values.push(updates.userNotes); }
    if (updates.markdownContent !== undefined) { fields.push("markdown_content = ?"); values.push(updates.markdownContent); }
    if (updates.richTextContent !== undefined) { fields.push("rich_text_content = ?"); values.push(updates.richTextContent); }
    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }

    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(now, id);

    db.run(`UPDATE reports SET ${fields.join(", ")} WHERE id = ?`, values);
    saveDatabase();
  }

  async delete(id: string): Promise<void> {
    const db = await getDatabase();
    db.run("DELETE FROM reports WHERE id = ?", [id]);
    saveDatabase();
  }

  private mapRow(r: any): Report {
    return {
      id: r.id, date: r.date, templateId: r.template_id,
      templateName: r.template_name,
      segmentIds: JSON.parse(r.segment_ids || "[]"),
      userNotes: r.user_notes || undefined,
      promptSnapshot: r.prompt_snapshot, aiInputSnapshot: r.ai_input_snapshot,
      markdownContent: r.markdown_content,
      richTextContent: r.rich_text_content || undefined,
      status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}

export const reportRepo = new ReportRepository();