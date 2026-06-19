import { getDatabase, saveDatabase } from "../connection";
import { KnowledgeNode, KnowledgeLink, KnowledgeGraphData } from "../../../shared/types";
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

/**
 * Wiki 知识库仓库
 * 参考 llm_wiki 项目：双链 [[]] 语法 + 知识图谱
 * knowledge_nodes 存储知识点，knowledge_links 存储双链关系
 */
export class KnowledgeRepository {
  async getAll(): Promise<KnowledgeNode[]> {
    const db = await getDatabase();
    const rows = queryAll(db, "SELECT * FROM knowledge_nodes ORDER BY updated_at DESC");
    return rows.map(this.mapRow);
  }

  async getById(id: string): Promise<KnowledgeNode | null> {
    const db = await getDatabase();
    const row = queryOne(db, "SELECT * FROM knowledge_nodes WHERE id = ?", [id]);
    return row ? this.mapRow(row) : null;
  }

  async getByTitle(title: string): Promise<KnowledgeNode | null> {
    const db = await getDatabase();
    const row = queryOne(db, "SELECT * FROM knowledge_nodes WHERE title = ?", [title]);
    return row ? this.mapRow(row) : null;
  }

  async save(node: Partial<KnowledgeNode> & { title: string; content: string }): Promise<KnowledgeNode> {
    const db = await getDatabase();
    const now = new Date().toISOString();

    if (node.id) {
      // 更新
      const existing = await this.getById(node.id);
      if (existing) {
        const updated: KnowledgeNode = {
          ...existing,
          title: node.title,
          content: node.content,
          summary: node.summary ?? existing.summary,
          tags: node.tags ?? existing.tags,
          source: node.source ?? existing.source,
          sourceSegmentIds: node.sourceSegmentIds ?? existing.sourceSegmentIds,
          linkedNodeIds: node.linkedNodeIds ?? existing.linkedNodeIds,
          updatedAt: now,
        };
        db.run(
          `UPDATE knowledge_nodes SET title = ?, content = ?, summary = ?, tags = ?, source = ?,
           source_segment_ids = ?, linked_node_ids = ?, updated_at = ? WHERE id = ?`,
          [
            updated.title, updated.content, updated.summary || null,
            JSON.stringify(updated.tags), updated.source,
            JSON.stringify(updated.sourceSegmentIds || []),
            JSON.stringify(updated.linkedNodeIds || []),
            now, updated.id,
          ]
        );
        // 重建双链
        await this.rebuildLinks(updated.id, updated.content);
        saveDatabase();
        return updated;
      }
    }

    // 新建
    const newNode: KnowledgeNode = {
      id: uuidv4(),
      title: node.title,
      content: node.content,
      summary: node.summary,
      tags: node.tags || [],
      source: node.source || "manual",
      sourceSegmentIds: node.sourceSegmentIds || [],
      linkedNodeIds: node.linkedNodeIds || [],
      createdAt: now,
      updatedAt: now,
    };
    db.run(
      `INSERT INTO knowledge_nodes (id, title, content, summary, tags, source, source_segment_ids, linked_node_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newNode.id, newNode.title, newNode.content, newNode.summary || null,
        JSON.stringify(newNode.tags), newNode.source,
        JSON.stringify(newNode.sourceSegmentIds), JSON.stringify(newNode.linkedNodeIds),
        newNode.createdAt, newNode.updatedAt,
      ]
    );
    await this.rebuildLinks(newNode.id, newNode.content);
    saveDatabase();
    return newNode;
  }

  async delete(id: string): Promise<void> {
    const db = await getDatabase();
    db.run("DELETE FROM knowledge_nodes WHERE id = ?", [id]);
    db.run("DELETE FROM knowledge_links WHERE source_id = ? OR target_id = ?", [id, id]);
    saveDatabase();
  }

  /**
   * 搜索知识点（标题 + 内容 + 标签）
   */
  async search(query: string): Promise<KnowledgeNode[]> {
    const db = await getDatabase();
    const keyword = `%${query}%`;
    const rows = queryAll(
      db,
      `SELECT * FROM knowledge_nodes
       WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
       ORDER BY updated_at DESC`,
      [keyword, keyword, keyword]
    );
    return rows.map(this.mapRow);
  }

  /**
   * 获取双链关系
   */
  async getLinks(nodeId: string): Promise<{ outgoing: KnowledgeLink[]; incoming: KnowledgeLink[] }> {
    const db = await getDatabase();
    const outgoing = queryAll(
      db,
      "SELECT * FROM knowledge_links WHERE source_id = ?",
      [nodeId]
    ).map((r) => ({ sourceId: r.source_id, targetId: r.target_id, context: r.context }));
    const incoming = queryAll(
      db,
      "SELECT * FROM knowledge_links WHERE target_id = ?",
      [nodeId]
    ).map((r) => ({ sourceId: r.source_id, targetId: r.target_id, context: r.context }));
    return { outgoing, incoming };
  }

  /**
   * 获取知识图谱数据（用于可视化）
   */
  async getGraph(): Promise<KnowledgeGraphData> {
    const db = await getDatabase();
    const nodes = queryAll(db, "SELECT * FROM knowledge_nodes ORDER BY updated_at DESC");
    const links = queryAll(db, "SELECT * FROM knowledge_links");

    // 计算每个节点的连接数
    const linkCountMap = new Map<string, number>();
    for (const link of links) {
      linkCountMap.set(link.source_id, (linkCountMap.get(link.source_id) || 0) + 1);
      linkCountMap.set(link.target_id, (linkCountMap.get(link.target_id) || 0) + 1);
    }

    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        title: n.title,
        summary: n.summary || undefined,
        tags: JSON.parse(n.tags || "[]"),
        linkCount: linkCountMap.get(n.id) || 0,
      })),
      edges: links.map((l) => ({ source: l.source_id, target: l.target_id })),
    };
  }

  /**
   * 重建某节点的双链关系
   * 解析 content 中的 [[标题]] 语法，建立到目标节点的链接
   */
  private async rebuildLinks(sourceId: string, content: string): Promise<void> {
    const db = await getDatabase();
    // 清除旧链接
    db.run("DELETE FROM knowledge_links WHERE source_id = ?", [sourceId]);

    // 解析 [[标题]] 双链
    const linkRegex = /\[\[([^\]]+)\]\]/g;
    const matches: string[] = [];
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      matches.push(match[1].trim());
    }

    const now = new Date().toISOString();
    const linkedNodeIds: string[] = [];

    for (const title of matches) {
      const targetNode = await this.getByTitle(title);
      if (targetNode && targetNode.id !== sourceId) {
        // 插入链接（忽略已存在的）
        try {
          db.run(
            "INSERT OR IGNORE INTO knowledge_links (source_id, target_id, context, created_at) VALUES (?, ?, ?, ?)",
            [sourceId, targetNode.id, `[[${title}]]`, now]
          );
          linkedNodeIds.push(targetNode.id);
        } catch {
          // 链接已存在，忽略
        }
      }
    }

    // 更新缓存的 linkedNodeIds
    db.run("UPDATE knowledge_nodes SET linked_node_ids = ? WHERE id = ?", [
      JSON.stringify(linkedNodeIds),
      sourceId,
    ]);
  }

  private mapRow(row: any): KnowledgeNode {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      summary: row.summary || undefined,
      tags: JSON.parse(row.tags || "[]"),
      source: row.source as "manual" | "extracted" | "imported",
      sourceSegmentIds: JSON.parse(row.source_segment_ids || "[]"),
      linkedNodeIds: JSON.parse(row.linked_node_ids || "[]"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const knowledgeRepo = new KnowledgeRepository();
