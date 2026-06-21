import { Outlet, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { TitleBar } from './TitleBar'
import { IconSidebar } from './IconSidebar'
import { ContextPanel } from './ContextPanel'

/**
 * 三栏布局骨架：
 * 顶部自定义标题栏 + 左侧 Icon Sidebar（窄栏）+ 中间 Main Workspace + 右侧 Context Panel。
 *
 * 同时监听来自桌面伙伴/托盘的导航指令（mascot:navigateMain），
 * 收到后通过 react-router 跳转到对应页面。
 */
export function AppLayout(): JSX.Element {
  const navigate = useNavigate()

  useEffect(() => {
    // 监听主进程发来的导航指令（来自 Mascot 气泡点击 / 托盘菜单 / 右键菜单）
    const unsubscribe = window.workmemory.mascot.onNavigate((page: string) => {
      const validPages = ['today', 'calendar', 'search', 'insights', 'wiki', 'graph', 'reports', 'settings']
      const target = validPages.includes(page) ? page : ''
      navigate(target === 'today' ? '/' : `/${target}`)
    })
    return () => {
      unsubscribe()
    }
  }, [navigate])

  return (
    <div className="wm-app">
      <TitleBar />
      <div className="wm-app-body">
        <IconSidebar />
        <main className="wm-app-main wm-scroll">
          <Outlet />
        </main>
        <aside className="wm-app-context wm-acrylic-panel">
          <div className="wm-app-context-inner">
            <div className="wm-context-header">
              <span className="wm-context-dot" />
              <span>上下文面板</span>
            </div>
            <ContextPanel />
          </div>
        </aside>
      </div>

      <style>{`
        .wm-app {
          height: 100vh;
          width: 100vw;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: var(--wm-color-background);
        }
        .wm-app-body {
          flex: 1;
          display: flex;
          min-height: 0;
        }
        .wm-app-main {
          flex: 1;
          min-width: 0;
          overflow-y: auto;
          padding: var(--wm-spacing-xl) var(--wm-spacing-xxl);
        }
        .wm-app-context {
          width: 320px;
          flex-shrink: 0;
          overflow-y: auto;
          padding: var(--wm-spacing-lg);
        }
        .wm-app-context-inner {
          display: flex;
          flex-direction: column;
          gap: var(--wm-spacing-md);
          height: 100%;
        }
        .wm-context-header {
          display: flex;
          align-items: center;
          gap: var(--wm-spacing-sm);
          font-size: 13px;
          font-weight: 600;
          color: var(--wm-color-text-secondary);
          padding-bottom: var(--wm-spacing-sm);
          border-bottom: 1px solid var(--wm-color-border);
        }
        .wm-context-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--wm-color-cyan);
        }
      `}</style>
    </div>
  )
}
