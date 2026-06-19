import { getDatabase, saveDatabase } from "../connection";
import { ReportTemplate } from "../../../shared/types";
import { v4 as uuidv4 } from "uuid";
import { BUILT_IN_TEMPLATES } from "../../services/templates";

function queryAll(db: any, sql: string, params?: any[]): any[] {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export class TemplateRepository {
  async getAll(): Promise<ReportTemplate[]> {
    const db = await getDatabase();
    let rows = queryAll(db, "SELECT * FROM report_templates ORDER BY is_built_in DESC, created_at ASC");
    let templates = rows.map(this.mapRow);
    if (templates.length === 0) {
      templates = await this.seedBuiltInTemplates();
    }
    return templates;
  }

  async getById(id: string): Promise<ReportTemplate | null> {
    const all = await this.getAll();
    return all.find((t) => t.id === id) || null;
  }

  async getDefault(): Promise<ReportTemplate | null> {
    const all = await this.getAll();
    return all.length > 0 ? all[0] : null;
  }

  async save(template: Omit<ReportTemplate, "id" | "createdAt" | "updatedAt">): Promise<ReportTemplate> {
    const db = await getDatabase();
    const id = uuidv4();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO report_templates (id, name, description, type, prompt, output_format, is_built_in, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, template.name, template.description, template.type, template.prompt, template.outputFormat, template.isBuiltIn ? 1 : 0, now, now]
    );
    saveDatabase();
    return { ...template, id, createdAt: now, updatedAt: now };
  }

  async update(id: string, updates: Partial<ReportTemplate>): Promise<void> {
    const db = await getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
    if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
    if (updates.type !== undefined) { fields.push("type = ?"); values.push(updates.type); }
    if (updates.prompt !== undefined) { fields.push("prompt = ?"); values.push(updates.prompt); }
    if (updates.outputFormat !== undefined) { fields.push("output_format = ?"); values.push(updates.outputFormat); }

    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(now, id);

    db.run(`UPDATE report_templates SET ${fields.join(", ")} WHERE id = ?`, values);
    saveDatabase();
  }

  async delete(id: string): Promise<void> {
    const existing = await this.getById(id);
    if (existing?.isBuiltIn) return;
    const db = await getDatabase();
    db.run("DELETE FROM report_templates WHERE id = ?", [id]);
    saveDatabase();
  }

  private async seedBuiltInTemplates(): Promise<ReportTemplate[]> {
    const templates: ReportTemplate[] = [];
    for (const t of BUILT_IN_TEMPLATES) {
      const saved = await this.save(t);
      templates.push(saved);
    }
    return templates;
  }

  private mapRow(r: any): ReportTemplate {
    return {
      id: r.id, name: r.name, description: r.description,
      type: r.type, prompt: r.prompt, outputFormat: r.output_format,
      isBuiltIn: r.is_built_in === 1,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}

export const templateRepo = new TemplateRepository();