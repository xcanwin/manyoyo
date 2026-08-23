import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { LoginPage } from "@/components/login-page"
import { ThemeProvider } from "@/components/theme-provider.tsx"

const isLoginRoute = window.location.pathname === "/shadcn/auth/login"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>{isLoginRoute ? <LoginPage /> : <App />}</ThemeProvider>
  </StrictMode>
)
