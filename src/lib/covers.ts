import type { ImageMetadata } from 'astro';

/**
 * Covers live at `src/assets/covers/<stem>.(avif|webp|jpg|png)`.
 * YAML frontmatter can't use Astro's `image()` helper, so novels store a
 * plain string (`cover: test-serial` or a path) and we resolve it here by
 * matching the file name stem. Returns `undefined` when no cover exists —
 * callers render the styled placeholder instead.
 */

const covers = import.meta.glob<ImageMetadata>('../assets/covers/*.{avif,webp,jpg,jpeg,png}', {
	eager: true,
	import: 'default',
});

function stem(path: string): string {
	const file = path.split('/').pop() ?? path;
	return file.replace(/\.[^.]+$/, '');
}

export function resolveCover(cover: string | undefined, novelSlug: string): ImageMetadata | undefined {
	// Accept `test-serial`, `test-serial.webp`, `covers/test-serial.webp`, or a bare slug fallback.
	const spec = cover?.trim() || novelSlug;
	const wanted = stem(spec);
	for (const [path, image] of Object.entries(covers)) {
		if (stem(path) === wanted) return image;
	}
	return undefined;
}
