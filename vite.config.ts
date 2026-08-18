import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // flue() MUST come before cloudflare(): flueWorkerConfig() throws if called
  // before flue() is registered. cloudflare() MUST receive the customizer —
  // a bare cloudflare() leaves the Worker with no agent DO bindings.
  plugins: [
    flue({ providers: ["openai", "anthropic"] }),
    cloudflare({ config: flueWorkerConfig() }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Vite 8 loads the config as ESM — __dirname is undefined; use import.meta.dirname.
      "@": path.resolve(import.meta.dirname, "./src/react-app"),
    },
  },
});