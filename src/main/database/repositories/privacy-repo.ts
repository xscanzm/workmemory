import { getDatabase, saveDatabase } from "../connection";
import { PrivacyRule } from "../../../shared/types";
import { v4 as uuidv4 } from "uuid";

function queryAll(db: any, sql: string, params?: any[]): any[] {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(db: any, sql: string, params?: any[]): any | null {
  const rows = queryAll(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 默认隐私黑名单（PRD 7.7 节）
 * 涵盖密码、支付、银行、身份证、医疗、私聊、无痕等敏感场景
 */
const DEFAULT_PRIVACY_RULES: Array<Omit<PrivacyRule, "id" | "createdAt" | "updatedAt">> = [
  { type: "window_title", pattern: "密码", matchMode: "contains", enabled: true },
  { type: "window_title", pattern: "password", matchMode: "contains", enabled: true },
  { type: "window_title", pattern: "支付", matchMode: "contains", enabled: true },
  { type: "window_title", pattern: "银行", matchMode: "contains", enabled: true },
  { type: "window_title", pattern: "bank", matchMode: "contains", enabled: true },
  { type: "window_title", pattern: "身份证", matchMode: "contains", enabled: true },
  { type: "window_title", pattern: "医疗", matchMode: "contains", enabled: true },
  { type: "window_title", pattern: "私聊", matchMode: "contains", enabled: true },
  { type: "window_title", pattern: "无痕", matchMode: "contains", enabled: true },
  { type: "window_title", pattern: "incognito", matchMode: "contains", enabled: true },
  { type: "window_title", pattern: "private", matchMode: "contains", enabled: true },
  { type: "app_name", pattern: "1Password", matchMode: "contains", enabled: true },
  { type: "app_name", pattern: "KeePass", matchMode: "contains", enabled: true },
  { type: "app_name", pattern: "Bitwarden", matchMode: "contains", enabled: true },
];

export class PrivacyRepository {
  async getAll(): Promise<PrivacyRule[]> {
    const db = await getDatabase();
    const rows = queryAll(db, "SELECT * FROM privacy_rules ORDER BY created_at ASC");
    return rows.map((r) => ({
      id: r.id, type: r.type, pattern: r.pattern,
      matchMode: r.match_mode, enabled: r.enabled === 1,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  async getEnabled(): Promise<PrivacyRule[]> {
    const all = await this.getAll();
    return all.filter((r) => r.enabled);
  }

  async save(rule: Omit<PrivacyRule, "id" | "createdAt" | "updatedAt">): Promise<PrivacyRule> {
    const db = await getDatabase();
    const id = uuidv4();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO privacy_rules (id, type, pattern, match_mode, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, rule.type, rule.pattern, rule.matchMode, rule.enabled ? 1 : 0, now, now]
    );
    saveDatabase();
    return { ...rule, id, createdAt: now, updatedAt: now };
  }

  async update(id: string, updates: Partial<PrivacyRule>): Promise<void> {
    const db = await getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.type !== undefined) { fields.push("type = ?"); values.push(updates.type); }
    if (updates.pattern !== undefined) { fields.push("pattern = ?"); values.push(updates.pattern); }
    if (updates.matchMode !== undefined) { fields.push("match_mode = ?"); values.push(updates.matchMode); }
    if (updates.enabled !== undefined) { fields.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }

    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(now);
    values.push(id);

    db.run(`UPDATE privacy_rules SET ${fields.join(", ")} WHERE id = ?`, values);
    saveDatabase();
  }

  async delete(id: string): Promise<void> {
    const db = await getDatabase();
    db.run("DELETE FROM privacy_rules WHERE id = ?", [id]);
    saveDatabase();
  }

  /**
   * 首次启动时预置默认隐私黑名单（PRD 7.7 节）
   * 仅在表中无任何规则时执行
   */
  async seedDefaultRules(): Promise<void> {
    const db = await getDatabase();
    const row = queryOne(db, "SELECT COUNT(*) as count FROM privacy_rules");
    if (row?.count > 0) return;

    const now = new Date().toISOString();
    for (const rule of DEFAULT_PRIVACY_RULES) {
      const id = uuidv4();
      db.run(
        `INSERT INTO privacy_rules (id, type, pattern, match_mode, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, rule.type, rule.pattern, rule.matchMode, rule.enabled ? 1 : 0, now, now]
      );
    }
    saveDatabase();
  }

  async matchesAny(appName: string, processName: string, windowTitle: string): Promise<boolean> {
    const rules = await this.getEnabled();
    for (const rule of rules) {
      let target = "";
      switch (rule.type) {
        case "app_name": target = appName; break;
        case "process_name": target = processName; break;
        case "window_title": target = windowTitle; break;
        default: continue;
      }

      switch (rule.matchMode) {
        case "contains":
          if (target.toLowerCase().includes(rule.pattern.toLowerCase())) return true;
          break;
        case "equals":
          if (target.toLowerCase() === rule.pattern.toLowerCase()) return true;
          break;
        case "regex":
          try {
            if (new RegExp(rule.pattern, "i").test(target)) return true;
          } catch { /* invalid regex */ }
          break;
      }
    }
    return false;
  }
}

export const privacyRepo = new PrivacyRepository();