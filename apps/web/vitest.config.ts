import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    // Playwright owns end-to-end; vitest covers logic and component behaviour.
    exclude: ["e2e/**", "node_modules/**"],
  },
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
});
