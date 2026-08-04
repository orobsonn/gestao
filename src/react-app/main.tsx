/** @description React SPA entry — ThemeProvider, AuthProvider, App, Sonner toaster. */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./providers/auth-provider";
import { Toaster } from "./components/ui/sonner";
import { DEFAULT_THEME } from "./lib/theme";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing #root element");
}

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme={DEFAULT_THEME}
      enableSystem
    >
      <AuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <Toaster />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
);
