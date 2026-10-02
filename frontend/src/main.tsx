import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { LoginPage } from "@/components/login-page"
import { ThemeProvider } from "@/components/theme-provider.tsx"

const isLoginRoute = window.location.pathname === "/auth/login"

// 一次性登录令牌无效时服务端会落在登录页：把令牌从地址栏和历史记录里抹掉
if (isLoginRoute && window.location.search) {
  window.history.replaceState(null, "", window.location.pathname)
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>{isLoginRoute ? <LoginPage /> : <App />}</ThemeProvider>
  </StrictMode>
)
