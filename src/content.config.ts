import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// 글 하나 = src/content/posts/<slug>.md
// date: 처음 쓴 날(velog 발행일 또는 노션에 처음 정리한 날). updated: 나중에 보강한 날이 있으면.
const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    description: z.string().default(""),
    tags: z.array(z.string()).default([]),
    series: z.string().optional(),
    velog: z.string().url().optional(), // 처음 올린 velog 주소 (날짜 근거)
    // 목록 박스 왼쪽 썸네일. 원본 대신 줄인 파일 (public/images/thumbs/<slug>.webp, 긴 변 최대 1400px)
    thumbnail: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
