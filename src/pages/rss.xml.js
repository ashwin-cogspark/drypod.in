import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_TITLE } from '../consts';
import { chapterHref, getAllChapters } from '../lib/library';

export async function GET(context) {
	const novels = await getCollection('novels');
	const novelTitle = (slug) => novels.find((n) => n.data.slug === slug)?.data.title ?? slug;
	const chapters = (await getAllChapters()).slice(0, 50);
	return rss({
		title: `${SITE_TITLE} — Latest Chapters`,
		description: 'New chapter updates from every serial on Drypod, newest first.',
		site: context.site,
		items: chapters.map((chapter) => ({
			title: `${novelTitle(chapter.data.novel)} — Ch ${chapter.data.number}: ${chapter.data.title}`,
			pubDate: chapter.data.pubDate,
			description: `${chapter.data.title} — chapter ${chapter.data.number} of ${novelTitle(chapter.data.novel)} (${chapter.data.wordCount} words).`,
			link: chapterHref(chapter.data.novel, chapter.data.number),
		})),
		customData: '<language>en</language>',
	});
}
