import { getCollection, type CollectionEntry } from "astro:content";

export const SITE = {
  name: "윤정환",
  role: "Infrastructure Engineer",
  description: "Kubernetes 위에 직접 만든 배포 플랫폼 KoDeploy를 운영하며 겪은 일을 기록합니다.",
  github: "https://github.com/yuntyu01",
  email: "yuntyu01@gmail.com",
  portfolio: "https://yuntyu01.github.io/PORTFOLIO/",
  kodeploy: "https://kodeploy.com/",
};

export type Post = CollectionEntry<"posts">;

// 공개 글, 최신순
export async function allPosts(): Promise<Post[]> {
  const posts = await getCollection("posts", (p) => !p.data.draft);
  return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

const pad = (n: number) => String(n).padStart(2, "0");
// 2026.05.15
export const fmtDate = (d: Date) => `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
// 05.15 (연도별 목록 안에서)
export const fmtMonthDay = (d: Date) => `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;

// 한국어 기준 대략 분당 700자. 코드 블록은 훑어보니 절반으로 센다.
export function readingMinutes(body: string): number {
  const code = (body.match(/```[\s\S]*?```/g) || []).join("");
  const text = body.length - code.length + code.length / 2;
  return Math.max(1, Math.round(text / 700));
}
