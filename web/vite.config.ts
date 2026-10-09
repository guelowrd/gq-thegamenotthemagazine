import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { midenVitePlugin } from "@miden-sdk/vite-plugin";

// The site's public address, for link previews (absolute URLs in index.html). SITE_URL wins; on
// Vercel the production domain is known at build time (a custom domain once one is added);
// otherwise the vercel.app address.
const siteUrl =
  process.env.SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://gq-thegamenotthemagazine.vercel.app");

export default defineConfig({
  plugins: [
    react(),
    midenVitePlugin({ crossOriginIsolation: true }),
    { name: "site-url", transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", siteUrl.replace(/\/$/, "")) },
  ],
  resolve: {
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
