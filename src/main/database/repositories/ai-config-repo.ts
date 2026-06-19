import { getDatabase, saveDatabase } from "../connection";
import { AiProviderConfig } from "../../../shared/types";
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

function obfuscate(key: string): string {
  return Buffer.from(key).toString("base64");
}

function deobfuscate(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf-8");
}

export class AiConfigRepository {
  async getAll(): Promise<AiProviderConfig[]> {
    const db = await getDatabase();
    const rows = queryAll(db, "SELECT * FROM ai_provider_configs ORDER BY created_at ASC");
    return rows.map((r) => ({
      id: r.id, name: r.name, providerType: r.provider_type,
      baseUrl: r.base_url, apiKeyEncrypted: r.api_key_encrypted,
      model: r.model, temperature: r.temperature,
      maxTokens: r.max_tokens, timeoutSeconds: r.timeout_seconds,
      stream: r.stream === 1, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  async getById(id: string): Promise<AiProviderConfig | null> {
    const all = await this.getAll();
    return all.find((c) => c.id === id) || null;
  }

  async getDefault(): Promise<AiProviderConfig | null> {
    const all = await this.getAll();
    return all.length > 0 ? all[0] : null;
  }

  async save(config: Omit<AiProviderConfig, "id" | "createdAt" | "updatedAt">): Promise<AiProviderConfig> {
    const db = await getDatabase();
    const id = uuidv4();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO ai_provider_configs (
        id, name, provider_type, base_url, api_key_encrypted,
        model, temperature, max_tokens, timeout_seconds, stream,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, config.name, config.providerType, config.baseUrl,
        obfuscate(config.apiKeyEncrypted), config.model,
        config.temperature, config.maxTokens || null,
        config.timeoutSeconds, config.stream ? 1 : 0, now, now,
      ]
    );
    saveDatabase();
    return { ...config, id, createdAt: now, updatedAt: now };
  }

  async update(id: string, updates: Partial<AiProviderConfig>): Promise<void> {
    const db = await getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
    if (updates.baseUrl !== undefined) { fields.push("base_url = ?"); values.push(updates.baseUrl); }
    if (updates.apiKeyEncrypted !== undefined) { fields.push("api_key_encrypted = ?"); values.push(obfuscate(updates.apiKeyEncrypted)); }
    if (updates.model !== undefined) { fields.push("model = ?"); values.push(updates.model); }
    if (updates.temperature !== undefined) { fields.push("temperature = ?"); values.push(updates.temperature); }
    if (updates.maxTokens !== undefined) { fields.push("max_tokens = ?"); values.push(updates.maxTokens); }
    if (updates.timeoutSeconds !== undefined) { fields.push("timeout_seconds = ?"); values.push(updates.timeoutSeconds); }
    if (updates.stream !== undefined) { fields.push("stream = ?"); values.push(updates.stream ? 1 : 0); }

    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(now, id);

    db.run(`UPDATE ai_provider_configs SET ${fields.join(", ")} WHERE id = ?`, values);
    saveDatabase();
  }

  async delete(id: string): Promise<void> {
    const db = await getDatabase();
    db.run("DELETE FROM ai_provider_configs WHERE id = ?", [id]);
    saveDatabase();
  }

  async getDecryptedApiKey(id: string): Promise<string | null> {
    const db = await getDatabase();
    const row = queryOne(db, "SELECT api_key_encrypted FROM ai_provider_configs WHERE id = ?", [id]);
    if (!row) return null;
    try {
      return deobfuscate(row.api_key_encrypted);
    } catch {
      return null;
    }
  }
}

export const aiConfigRepo = new AiConfigRepository();