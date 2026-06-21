import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { Today } from './pages/Today'
import { Calendar } from './pages/Calendar'
import { Search } from './pages/Search'
import { Insights } from './pages/Insights'
import { Wiki } from './pages/Wiki'
import { Graph } from './pages/Graph'
import { Reports } from './pages/Reports'
import { Settings } from './pages/Settings'
import Mascot from './pages/Mascot'
import { ToastContainer } from '@/ui'

export default function App(): JSX.Element {
  return (
    <>
      <HashRouter>
        <Routes>
          {/* Mascot 独立透明窗口路由（不使用 AppLayout） */}
          <Route path="/mascot" element={<Mascot />} />
          <Route path="/" element={<AppLayout />}>
            <Route index element={<Today />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="search" element={<Search />} />
            <Route path="insights" element={<Insights />} />
            <Route path="wiki" element={<Wiki />} />
            <Route path="graph" element={<Graph />} />
            <Route path="reports" element={<Reports />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
      <ToastContainer />
    </>
  )
}
