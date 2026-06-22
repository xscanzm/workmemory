import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { workmemory } from './lib/tauri-api'

// 注入 Tauri 适配器，替换原 Electron preload 暴露的 window.workmemory API
window.workmemory = workmemory

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
