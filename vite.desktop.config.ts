import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// A static client build of the SAME route tree. Lovable's Start config stays intact.
export default defineConfig({
  define: { "import.meta.env.VITE_DESKTOP": "true" },
  root: "desktop",
  publicDir: "../public",
  plugins: [
    react(),
    tailwind(),
    {
      name: "desktop-dev-csp",
      transformIndexHtml(html, context) {
        // Vite's React refresh preamble is inline only during local development.
        return context.server
          ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
          : html;
      },
    },
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  build: { outDir: "../dist-desktop", emptyOutDir: true },
});
