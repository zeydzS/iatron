import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "./",
  publicDir: "public",
  plugins: [react()],
  server: { fs: { allow: [fileURLToPath(new URL("../", import.meta.url))] } },
  build: { outDir: "../dist", emptyOutDir: true },
});
