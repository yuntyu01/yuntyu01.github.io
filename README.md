# yuntyu01.github.io

**Live:** https://yuntyu01.github.io/

ARCHIVE 홈 · 블로그 · 포트폴리오를 한 저장소에서 관리합니다. Astro로 빌드해 GitHub Pages에 올립니다 (`main`에 푸시하면 GitHub Actions가 배포).

## 구조

| 경로 | 역할 |
|---|---|
| `src/pages/index.astro` | ARCHIVE 홈 — PROJECTS · PORTFOLIO 버튼 · BLOG(카테고리별) · 오른쪽 목차 |
| `src/pages/posts/` | 글 목록(`/posts/`)과 글 페이지(`/posts/<글 이름>/`) |
| `src/content/posts/` | 블로그 글(.md) — 폴더 2단계가 카테고리 2단계 |
| `public/PORTFOLIO/PORTFOLIO.html` | 포트폴리오 (`/PORTFOLIO/`). 스타일·스크립트가 다 들어 있는 단일 HTML |
| `public/images/` | 글 이미지(`posts/<글 이름>/`)와 목록 썸네일(`thumbs/`) |

## 블로그 글 쓰기

```
src/content/posts/
├── KoDeploy/            ← 큰 카테고리
│   ├── 트러블슈팅/       ← 세부 카테고리
│   │   └── buildkit-dns-timeout.md
│   └── 성능/
└── Dailo/
    └── 장애 분석/
```

- 폴더를 만들고 `.md`를 넣으면 홈과 `/posts/`의 카테고리에 저절로 나타납니다.
- 글 주소는 폴더와 상관없이 `/posts/<파일 이름>/` — 폴더를 옮겨도 주소가 그대로입니다. 그래서 파일 이름은 겹치면 안 됩니다.
- 큰 카테고리 순서는 `src/lib/site.ts`의 `CATEGORY_ORDER`. 세부 카테고리는 이름순이고, `01-트러블슈팅`처럼 번호를 붙이면 그 순서가 됩니다 (번호는 화면에 안 나옴).
- 머리말: `title`, `date`, `description`, `tags`, `series`, `thumbnail`, `draft` (`src/content.config.ts` 참고).

## 포트폴리오 고치기

`public/PORTFOLIO/PORTFOLIO.html`을 직접 고치거나, 사이트의 포트폴리오 화면 오른쪽 위 **수정**으로 고친 뒤 "파일에 바로 저장"(이 파일을 고르면 됨) 또는 "HTML 내려받기"로 받은 파일로 덮어쓰고 푸시합니다. PDF 저장은 화면의 "PDF 저장".

## 다크 모드

모든 페이지 오른쪽 위 달/해 버튼. 고른 값은 브라우저에 기억되고(홈·블로그·포트폴리오 공유), 고르기 전에는 OS 설정을 따릅니다. 인쇄·PDF는 항상 라이트입니다.

## 로컬에서 보기

```bash
pnpm install
pnpm dev
```
