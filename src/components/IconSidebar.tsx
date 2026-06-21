import { useLocation, useNavigate } from 'react-router-dom'
import { navAccentColors } from '../design-system/theme'
import {
  Home,
  Calendar,
  Search,
  Lightbulb,
  BookOpen,
  Share2,
  FileText,
  Settings,
  IconButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  type Icon
} from '@/ui'
import styles from './IconSidebar.module.css'

interface NavItem {
  id: string
  label: string
  path: string
  accent: string
  icon: Icon
}

const items: NavItem[] = [
  { id: 'today', label: '今日', path: '/', accent: navAccentColors.today, icon: Home },
  { id: 'calendar', label: '日历', path: '/calendar', accent: navAccentColors.calendar, icon: Calendar },
  { id: 'search', label: '搜索', path: '/search', accent: navAccentColors.search, icon: Search },
  { id: 'insights', label: '洞察', path: '/insights', accent: navAccentColors.insights, icon: Lightbulb },
  { id: 'wiki', label: '知识库', path: '/wiki', accent: navAccentColors.wiki, icon: BookOpen },
  { id: 'graph', label: '图谱', path: '/graph', accent: navAccentColors.graph, icon: Share2 },
  { id: 'reports', label: '报告', path: '/reports', accent: navAccentColors.reports, icon: FileText },
  { id: 'settings', label: '设置', path: '/settings', accent: navAccentColors.settings, icon: Settings }
]

/**
 * 左侧窄栏 Icon Sidebar：8 个导航项，亚克力背景。
 * 图标按钮 + Tooltip 悬浮标签，激活态使用各导航项专属强调色。
 */
export function IconSidebar(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()

  const isActive = (path: string): boolean =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)

  return (
    <nav className={`wm-acrylic-sidebar wm-scroll-thin ${styles.sidebar}`}>
      <TooltipProvider>
        {items.map((item) => {
          const Icon = item.icon
          const active = isActive(item.path)
          const className = [
            styles.navItem,
            active ? styles.navItemActive : ''
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <IconButton
                  label={item.label}
                  size="md"
                  variant="ghost"
                  className={className}
                  icon={<Icon size={20} />}
                  onClick={() => navigate(item.path)}
                  style={{
                    ['--nav-accent' as string]: item.accent
                  }}
                />
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          )
        })}
      </TooltipProvider>
    </nav>
  )
}
