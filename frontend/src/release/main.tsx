import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "../index.css"
import { ThemeProvider } from "@/components/theme-provider.tsx"

import { ReleaseApp } from "./release-app"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ReleaseApp />
    </ThemeProvider>
  </StrictMode>
)
