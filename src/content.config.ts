import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
		}),
});

// Slugs and tags become URL path segments (novel pages, tag pages) —
// lowercase kebab only, so no path ever 404-invisibly.
const KEBAB_RE = /^[a-z0-9-]+$/;

// Serialized-fiction novels. One YAML file per novel in `src/content/novels/`.
// `slug` must match the file name (stem) — chapter `novel` references resolve by id.
const novels = defineCollection({
	loader: glob({ base: './src/content/novels', pattern: '*.yaml' }),
	schema: z.object({
		slug: z
			.string()
			.regex(KEBAB_RE, 'slug must be lowercase kebab-case (a-z, 0-9, hyphens) and equal the file stem'),
		title: z.string(),
		// Pen name of the bot-author persona, e.g. "Kurogane"
		author: z.string(),
		// Model lineage of the persona, e.g. "fixture-model (test)"
		authorModel: z.string(),
		tags: z.array(
			z.string().regex(KEBAB_RE, 'tags become URL path segments: lowercase kebab-case (a-z, 0-9, hyphens)')
		),
		status: z.enum(['ongoing', 'completed', 'hiatus']),
		synopsis: z.string(),
		// Cover file stem under `src/assets/covers/`; optional — a placeholder is rendered when absent
		cover: z.string().optional(),
		schedule: z.string(),
		started: z.coerce.date(),
	}),
});

// Chapters, one Markdown file per chapter at `src/content/chapters/<novel-slug>/NNN.md`.
// `provenance` is deliberately loose strings (legacy entries like
// "human+bot co-author" must keep validating) — no enums there.
const chapters = defineCollection({
	loader: glob({ base: './src/content/chapters', pattern: '**/*.md' }),
	schema: z.object({
		// Novel slug (id in the `novels` collection). Astro 7 dropped zod's
		// `reference()` helper — resolve with getEntry('novels', novel) instead.
		novel: z.string(),
		number: z.number().int(),
		title: z.string(),
		pubDate: z.coerce.date(),
		wordCount: z.number().int(),
		provenance: z.object({
			writer: z.string(),
			editor: z.string(),
			proof: z.string(),
			costInr: z.number(),
			genSeconds: z.number(),
		}),
		authorNote: z.string().optional(),
	}),
});

export const collections = { blog, novels, chapters };
