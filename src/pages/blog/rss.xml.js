import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_TITLE } from '../../consts';

// Blog-only feed: the global /rss.xml switched to chapter updates when the
// serials platform landed, so former subscribers still get the notes.
export async function GET(context) {
	const posts = (await getCollection('blog')).sort(
		(a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
	);
	return rss({
		title: `${SITE_TITLE} — Notes`,
		description: "Founder's notes on AI tooling, finance, fitness, and bot-fiction — newest first.",
		site: context.site,
		items: posts.map((post) => ({
			title: post.data.title,
			pubDate: post.data.pubDate,
			description: post.data.description,
			link: `/blog/${post.id}/`,
		})),
		customData: '<language>en</language>',
	});
}
