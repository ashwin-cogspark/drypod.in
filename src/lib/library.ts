import { getCollection, type CollectionEntry } from 'astro:content';

export type Novel = CollectionEntry<'novels'>;
export type Chapter = CollectionEntry<'chapters'>;

/** `/novels/<slug>/<NNN>/` — chapter URLs use the zero-padded number. */
export function chapterHref(novelSlug: string, number: number): string {
	return `/novels/${novelSlug}/${String(number).padStart(3, '0')}/`;
}

/** All chapters across all novels, newest first (latest-updates feed order). */
export async function getAllChapters(): Promise<Chapter[]> {
	const chapters = await getCollection('chapters');
	return chapters.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** Chapters of one novel, oldest first (reader-facing index order). */
export async function getNovelChapters(novelSlug: string): Promise<Chapter[]> {
	const chapters = await getCollection('chapters', ({ data }) => data.novel === novelSlug);
	return chapters.sort((a, b) => a.data.number - b.data.number);
}

export async function novelsByTag(tag: string): Promise<Novel[]> {
	const novels = await getCollection('novels', ({ data }) => data.tags.includes(tag));
	return novels.sort((a, b) => b.data.started.valueOf() - a.data.started.valueOf());
}

export function allTags(novels: Novel[]): Map<string, number> {
	const tags = new Map<string, number>();
	for (const novel of novels) {
		for (const tag of novel.data.tags) {
			tags.set(tag, (tags.get(tag) ?? 0) + 1);
		}
	}
	return new Map([...tags.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** URL-safe slug for pen names, e.g. "Kurogane" -> "kurogane". */
export function penNameSlug(penName: string): string {
	return penName
		.toLowerCase()
		.trim()
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export interface AuthorStats {
	penName: string;
	authorModel: string;
	novels: Novel[];
	chapterCount: number;
	totalCostInr: number;
	totalWords: number;
}

export async function authors(): Promise<AuthorStats[]> {
	const [novels, chapters] = await Promise.all([getCollection('novels'), getCollection('chapters')]);
	const byPen = new Map<string, AuthorStats>();
	for (const novel of novels) {
		const key = penNameSlug(novel.data.author);
		const stats =
			byPen.get(key) ??
			({
				penName: novel.data.author,
				authorModel: novel.data.authorModel,
				novels: [],
				chapterCount: 0,
				totalCostInr: 0,
				totalWords: 0,
			} satisfies AuthorStats);
		stats.novels.push(novel);
		byPen.set(key, stats);
	}
	for (const chapter of chapters) {
		const novel = novels.find((n) => n.data.slug === chapter.data.novel);
		if (!novel) continue;
		const stats = byPen.get(penNameSlug(novel.data.author));
		if (!stats) continue;
		stats.chapterCount += 1;
		stats.totalCostInr += chapter.data.provenance.costInr;
		stats.totalWords += chapter.data.wordCount;
	}
	return [...byPen.values()].sort((a, b) => b.chapterCount - a.chapterCount);
}

/** Build-time relative time, e.g. "2h ago". Static pages regenerate on deploy. */
export function relativeTime(date: Date, now: Date = new Date()): string {
	const seconds = Math.round((now.valueOf() - date.valueOf()) / 1000);
	if (seconds < 60) return 'just now';
	const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		['year', 31536000],
		['month', 2592000],
		['week', 604800],
		['day', 86400],
		['hour', 3600],
		['minute', 60],
	];
	for (const [unit, secsPerUnit] of units) {
		if (seconds >= secsPerUnit) {
			const value = Math.floor(seconds / secsPerUnit);
			return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(-value, unit);
		}
	}
	return 'just now';
}
