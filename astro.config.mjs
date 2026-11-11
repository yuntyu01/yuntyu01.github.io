import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
// 한글 바로 옆의 **"강조"**로 같은 굵게가 풀리지 않게 — 기본 CommonMark 규칙은 문장부호+한글 사이의 ** 를 닫지 못한다
import remarkCjkFriendly from "remark-cjk-friendly";
// 따옴표 다듬기만 쓰고 -- → — 변환은 끈다 (주소 속 --까지 —로 바뀌었다). 기본 smartypants는 옵션을 못 받아 직접 붙인다
import remarkSmartypants from "remark-smartypants";

export default defineConfig({
  site: "https://yuntyu01.github.io",
  trailingSlash: "always",
  integrations: [sitemap()],
  markdown: {
    smartypants: false,
    remarkPlugins: [remarkCjkFriendly, [remarkSmartypants, { dashes: false }]],
    // 코드 색을 라이트/다크 두 벌로 만들고, 어느 쪽을 쓸지는 global.css가 테마에 맞춰 고른다
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" }, defaultColor: false, wrap: false },
  },
});
