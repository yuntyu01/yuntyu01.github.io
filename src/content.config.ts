import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// 글 하나 = src/content/posts/<큰 카테고리>/<세부 카테고리>/<slug>.md
//   · 폴더 2단계가 그대로 카테고리 2단계가 된다 (예: KoDeploy/트러블슈팅/buildkit-dns-timeout.md)
//   · 큰 카테고리 폴더 바로 아래 둔 글은 큰 카테고리에만 속한다
//   · 폴더 이름 앞의 "01-" 같은 번호는 정렬용 - 화면에는 안 나온다
//   · 글 주소는 폴더와 상관없이 /posts/<파일 이름>/ - 폴더를 옮겨도 주소가 바뀌지 않는다
//     (그래서 파일 이름은 폴더가 달라도 겹치면 안 된다)
// date: 처음 쓴 날(velog 발행일 또는 노션에 처음 정리한 날). updated: 나중에 보강한 날이 있으면.
const posts = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "./src/content/posts",
    generateId: ({ entry }) => entry.replace(/^.*\//, "").replace(/\.md$/i, ""),
  }),
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
