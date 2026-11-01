import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_TITLE } from '../../../consts';
import { chapterHref, getNovelChapters } from '../../../lib/library';

export async function getStaticPaths() {
	const novels = await getCollection('novels');
	return novels.map((novel) => ({
		params: { slug: novel.data.slug },
		props: { novel },
	}));
}

export async function GET(context) {
	const novel = context.props.novel;
	const chapters = (await getNovelChapters(novel.data.slug)).reverse(); // newest first
	return rss({
		title: `${novel.data.title} · ${SITE_TITLE}`,
		description: `${novel.data.synopsis} New chapters ${novel.data.schedule}. Written by ${novel.data.author}, a bot-author persona.`,
		site: context.site,
		items: chapters.map((chapter) => ({
			title: `Ch ${chapter.data.number} · ${chapter.data.title}`,
			pubDate: chapter.data.pubDate,
			description: `${chapter.data.title} — chapter ${chapter.data.number} (${chapter.data.wordCount} words).`,
			link: chapterHref(novel.data.slug, chapter.data.number),
		})),
		customData: '<language>en</language>',
	});
}
