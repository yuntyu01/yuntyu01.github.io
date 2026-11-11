import { getCollection, type CollectionEntry } from "astro:content";

export const SITE = {
  name: "윤정환",
  role: "Infrastructure Engineer",
  description: "Kubernetes 위에 직접 만든 배포 플랫폼 KoDeploy를 운영하며 겪은 일을 기록합니다.",
  github: "https://github.com/yuntyu01",
  email: "yuntyu01@gmail.com",
  portfolio: "/PORTFOLIO/", // 포트폴리오 한 장 = public/PORTFOLIO/index.html (예전 PORTFOLIO 저장소에서 옮겨 옴)
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

// ── 카테고리 (폴더 2단계) ─────────────────────────────────
// 글 파일이 놓인 폴더가 곧 카테고리: src/content/posts/<큰>/<세부>/<slug>.md
const POSTS_DIR = "src/content/posts/";
const nfc = (s: string) => (s.normalize ? s.normalize("NFC") : s); // 맥에서 만든 한글 폴더 이름(NFD) 대비
// "01-KoDeploy" → "KoDeploy" (번호는 정렬용)
export const catLabel = (name: string) => name.replace(/^\d{1,3}[._-]\s*/, "") || name;
// 영문 → 한글 순, 01·02·10 숫자 순
const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
// 큰 카테고리를 보여 줄 순서 (홈 Projects와 같게). 여기 없는 카테고리는 그 뒤에 이름순
export const CATEGORY_ORDER = ["KoDeploy", "Dailo"];
const byOrder = (a: string, b: string) => {
  const rank = (n: string) => { const i = CATEGORY_ORDER.indexOf(catLabel(n)); return i < 0 ? CATEGORY_ORDER.length : i; };
  return rank(a) - rank(b) || byName(a, b);
};

export function categoryOf(post: Post): { cat: string; sub: string } {
  const rel = nfc(post.filePath ?? "").replace(/\\/g, "/").split(POSTS_DIR).pop() ?? "";
  const dirs = rel.split("/").slice(0, -1);
  return { cat: dirs[0] ?? "", sub: dirs[1] ?? "" };
}
// "KoDeploy › 트러블슈팅"
export const categoryPath = (post: Post) => {
  const { cat, sub } = categoryOf(post);
  return [cat, sub].filter(Boolean).map(catLabel).join(" › ");
};

export type Category = { name: string; label: string; count: number; subs: { name: string; label: string; count: number }[] };
export function categories(posts: Post[]): Category[] {
  const cats = new Map<string, { count: number; subs: Map<string, number> }>();
  for (const p of posts) {
    const { cat, sub } = categoryOf(p);
    if (!cat) continue; // 카테고리 폴더 밖(blog 맨 위)에 둔 글은 '전체'에만
    const c = cats.get(cat) ?? { count: 0, subs: new Map<string, number>() };
    c.count++;
    if (sub) c.subs.set(sub, (c.subs.get(sub) ?? 0) + 1);
    cats.set(cat, c);
  }
  return [...cats.keys()].sort(byOrder).map((name) => {
    const c = cats.get(name)!;
    return {
      name,
      label: catLabel(name),
      count: c.count,
      subs: [...c.subs.keys()].sort(byName).map((s) => ({ name: s, label: catLabel(s), count: c.subs.get(s)! })),
    };
  });
}
