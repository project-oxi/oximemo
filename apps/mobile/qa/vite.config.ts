import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Test-only native responses. The production entry never imports this config.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: fileURLToPath(new URL("./mock-native.ts", import.meta.url)) },
      { find: /^@tauri-apps\/plugin-barcode-scanner$/, replacement: fileURLToPath(new URL("./mock-scanner.ts", import.meta.url)) },
    ],
  },
  server: { host: "127.0.0.1", port: 5186, strictPort: true },
});
