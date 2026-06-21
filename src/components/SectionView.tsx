import { useEffect, useState } from 'react'

interface SectionMeta {
  title: string
  subtitle: string
  description: string
  accent: string
}

const sectionMap: Record<string, SectionMeta> = {
  today: {
    title: '今日',
    subtitle: 'Today',
    description: '三栏桌面布局核心看板：记录状态条、今日一句话总结卡、垂直时间轴 Episode 卡片、原始 Segment 列表（默认折叠）。',
    accent: 'var(--wm-color-accent)'
  },
  calendar: {
    title: '日历',
    subtitle: 'Calendar',
    description: '月视图 / 周视图网格，单元格显示日期、工作时长估算、高产度小横条、日报状态标记。',
    accent: 'var(--wm-color-cyan)'
  },
  search: {
    title: '搜索',
    subtitle: 'Search',
    description: '自然语言语义搜索：最佳匹配 Episode、关联事件链、关联实体，右侧高亮匹配原因。',
    accent: '#7c5cff'
  },
  insights: {
    title: '洞察',
    subtitle: 'Insights',
    description: '时间审计看板：项目 / 联系人 / 工作类型时间分布，异常与效率洞察（窗口切换次数、碎片合并建议）。',
    accent: '#f5a623'
  },
  wiki: {
    title: '知识库',
    subtitle: 'Wiki',
    description: '[[wikilink]] 双链沉淀中心：一句话、当前进展、关键事实、待确认、反链；左侧按人/项目/需求/客户分类；含 Review Queue。',
    accent: '#22b56a'
  },
  graph: {
    title: '图谱',
    subtitle: 'Graph',
    description: '记忆导图：选定日期或项目下人/事/文档/Wiki 页/报告节点关联，节点颜色区分，支持点击穿透与框选导出。',
    accent: '#e5484d'
  },
  reports: {
    title: '报告',
    subtitle: 'Reports',
    description: '日报、周报与复盘中心：富文本编辑、复制、Markdown / Word / JSON 导出，显示报告生成历史记录。',
    accent: 'var(--wm-color-accent)'
  },
  settings: {
    title: '设置',
    subtitle: 'Settings',
    description: '开机自启、保存截图天数限制（0-7）、本地 OCR 模型（tiny/small）、API Key 配置、敏感黑名单、桌面伙伴样式、数据瘦身/清空。',
    accent: '#5a6a7e'
  }
}

/**
 * 区块概览视图：阶段 0 骨架，展示区块名称与功能描述。
 * 阶段 6 将由各页面完整实现替换。
 */
export function SectionView({ sectionId }: { sectionId: string }): JSX.Element {
  const meta = sectionMap[sectionId] ?? sectionMap.today
  const [today, setToday] = useState<string>('')

  useEffect(() => {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    setToday(`${y}-${m}-${day}`)
  }, [])

  return (
    <div className="wm-section">
      <header className="wm-section-header">
        <div className="wm-section-titles">
          <h1 className="wm-section-title" style={{ color: meta.accent }}>
            {meta.title}
          </h1>
          <span className="wm-section-subtitle">{meta.subtitle}</span>
        </div>
        <div className="wm-section-date">今日 · {today}</div>
      </header>

      <section className="wm-acrylic-card wm-section-card">
        <div className="wm-section-card-badge" style={{ background: meta.accent }}>
          V0.3
        </div>
        <h2 className="wm-section-card-title">{meta.title} 模块</h2>
        <p className="wm-section-card-desc">{meta.description}</p>
        <div className="wm-section-card-status">
          <span className="wm-status-dot" style={{ background: meta.accent }} />
          <span>脚手架与数据层已就绪，完整页面交互将在阶段 6 实现</span>
        </div>
      </section>

      <style>{`
        .wm-section {
          max-width: 880px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: var(--wm-spacing-xl);
        }
        .wm-section-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
        }
        .wm-section-titles {
          display: flex;
          align-items: baseline;
          gap: var(--wm-spacing-sm);
        }
        .wm-section-title {
          font-size: 28px;
          font-weight: 700;
          margin: 0;
          letter-spacing: 0.5px;
        }
        .wm-section-subtitle {
          font-size: 13px;
          color: var(--wm-color-text-muted);
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        .wm-section-date {
          font-size: 13px;
          color: var(--wm-color-text-secondary);
        }
        .wm-section-card {
          padding: var(--wm-spacing-xl);
          display: flex;
          flex-direction: column;
          gap: var(--wm-spacing-md);
          position: relative;
        }
        .wm-section-card-badge {
          position: absolute;
          top: var(--wm-spacing-lg);
          right: var(--wm-spacing-lg);
          color: #fff;
          font-size: 11px;
          font-weight: 600;
          padding: 2px 8px;
          border-radius: var(--wm-radius-pill);
        }
        .wm-section-card-title {
          font-size: 18px;
          font-weight: 600;
          color: var(--wm-color-text-primary);
          margin: 0;
        }
        .wm-section-card-desc {
          font-size: 14px;
          color: var(--wm-color-text-secondary);
          line-height: 1.7;
          margin: 0;
        }
        .wm-section-card-status {
          display: flex;
          align-items: center;
          gap: var(--wm-spacing-sm);
          margin-top: var(--wm-spacing-sm);
          font-size: 12px;
          color: var(--wm-color-text-muted);
        }
        .wm-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }
      `}</style>
    </div>
  )
}
