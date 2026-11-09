import rss from "@astrojs/rss";
import { allPosts, SITE } from "../lib/site";

export async function GET(context) {
  const posts = await allPosts();
  return rss({
    title: `${SITE.name} 블로그`,
    description: SITE.description,
    site: context.site,
    items: posts.map((p) => ({
      title: p.data.title,
      pubDate: p.data.date,
      description: p.data.description,
      link: `/posts/${p.id}/`,
    })),
  });
}
