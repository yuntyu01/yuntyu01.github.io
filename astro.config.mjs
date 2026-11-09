import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://yuntyu01.github.io",
  trailingSlash: "always",
  integrations: [sitemap()],
  markdown: {
    shikiConfig: { theme: "github-light", wrap: false },
  },
});
