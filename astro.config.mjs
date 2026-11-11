import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://yuntyu01.github.io",
  trailingSlash: "always",
  integrations: [sitemap()],
  markdown: {
    // 코드 색을 라이트/다크 두 벌로 만들고, 어느 쪽을 쓸지는 global.css가 테마에 맞춰 고른다
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" }, defaultColor: false, wrap: false },
  },
});
