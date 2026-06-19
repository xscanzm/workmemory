import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DesktopPet } from "./pages/DesktopPet";
import { ConfirmProvider } from "./components/ConfirmDialog";
import "./styles/global.css";

// 检测是否是 pet 窗口（通过 hash 路由 /pet）
const isPetWindow = window.location.hash.replace(/^#/, "") === "/pet";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfirmProvider>
      {isPetWindow ? <DesktopPet /> : <App />}
    </ConfirmProvider>
  </React.StrictMode>
);
