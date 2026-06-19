import { getDatabase, saveDatabase } from "../connection";
import { AppConfig, DEFAULT_APP_CONFIG } from "../../../shared/types";

function queryOne(db: any, sql: string, params?: any[]): any | null {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

export class ConfigRepository {
  async getConfig(): Promise<AppConfig> {
    const db = await getDatabase();
    const row = queryOne(db, "SELECT value FROM app_config WHERE key = 'app_config'");

    if (!row) {
      return { ...DEFAULT_APP_CONFIG };
    }

    try {
      return { ...DEFAULT_APP_CONFIG, ...JSON.parse(row.value) };
    } catch {
      return { ...DEFAULT_APP_CONFIG };
    }
  }

  async saveConfig(config: Partial<AppConfig>): Promise<void> {
    const db = await getDatabase();
    const current = await this.getConfig();
    const merged = { ...current, ...config };
    const value = JSON.stringify(merged);

    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)", ["app_config", value]);
    saveDatabase();
  }
}

export const configRepo = new ConfigRepository();