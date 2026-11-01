#!/usr/bin/env node
// Content-policy lint for serialized fiction (plan P3.5).
//
// Runs checks BEYOND the zod schemas in src/content.config.ts (zod already
// gates `astro build`): word-count minimum and honesty, provenance
// completeness, novel references, duplicate chapter numbers, filename
// padding, and pubDate parseability — plus novel-yaml integrity: slug
// presence/charset/equality with the file stem (the site resolves chapters
// by the yaml `slug:` field, so a slug!=stem mismatch silently drops every
// chapter of that novel) and tag charset (tags become URL path segments).
//
// Zero dependencies — plain ESM on node >= 22.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIN_WORDS = 800;
const HONESTY_TOLERANCE = 0.1; // |declared - actual| must not exceed 10% of actual
const SLUG_RE = /^[a-z0-9-]+$/; // slugs and tags are URL path segments

// ---------------------------------------------------------------------------
// Frontmatter parsing — tolerant and minimal, for exactly our chapter shape:
// flat scalars, one nested `provenance:` block, and `>-`/`|` block scalars.
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function unquote(value) {
	if (value.length >= 2) {
		const first = value[0];
		const last = value.at(-1);
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

function stripComment(value) {
	// Tolerant: drop ` # ...` trailers on unquoted values.
	const idx = value.indexOf(' #');
	return idx === -1 ? value : value.slice(0, idx);
}

function coerceScalar(raw) {
	const value = stripComment(raw.trim());
	const unquoted = unquote(value);
	// Only UNQUOTED numerics become numbers: a quoted `"800"` must stay a
	// string so lint flags it — it passes here but fails zod at build time.
	if (value !== unquoted) return unquoted;
	if (/^-?\d+$/.test(unquoted)) return Number.parseInt(unquoted, 10);
	if (/^-?\d+\.\d+$/.test(unquoted)) return Number.parseFloat(unquoted);
	return unquoted;
}

/**
 * Split a chapter file into parsed frontmatter data and the markdown body.
 * Throws an Error naming the problem when frontmatter is missing or a line
 * does not match the expected `key: value` shape.
 */
export function parseFrontmatter(text) {
	const match = FRONTMATTER_RE.exec(text);
	if (!match) {
		throw new Error('frontmatter missing (no `---` delimited block at top of file)');
	}
	const lines = match[1].split(/\r?\n/);
	const data = {};
	let i = 0;

	// Collect the run of indented (or blank) lines that follows the cursor.
	const takeIndented = () => {
		const collected = [];
		while (i < lines.length && (lines[i].trim() === '' || /^[ \t]+\S/.test(lines[i]))) {
			if (lines[i].trim() !== '') collected.push(lines[i]);
			i++;
		}
		return collected;
	};

	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === '' || /^\s*#/.test(line)) {
			i++;
			continue;
		}
		const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!keyMatch) {
			throw new Error(`frontmatter unparseable at "${line.trim()}"`);
		}
		const key = keyMatch[1];
		const rest = keyMatch[2].trim();
		i++;

		if (rest === '>' || rest === '>-' || rest === '|' || rest === '|-') {
			// Block scalar: join with spaces — chapter linting never needs newlines.
			data[key] = takeIndented().map((l) => l.trim()).join(' ').trim();
		} else if (rest === '') {
			// Nested mapping (e.g. `provenance:`) or a bare null value.
			const nested = takeIndented();
			if (nested.length === 0) {
				data[key] = null;
			} else if (nested.every((l) => /^\s+[A-Za-z0-9_-]+:(\s|$)/.test(l))) {
				const obj = {};
				for (const nestedLine of nested) {
					const nestedMatch = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(nestedLine);
					obj[nestedMatch[1]] = coerceScalar(nestedMatch[2]);
				}
				data[key] = obj;
			} else {
				data[key] = nested.map((l) => l.trim()).join(' ');
			}
		} else {
			data[key] = coerceScalar(rest);
		}
	}

	return { data, body: text.slice(match[0].length) };
}

/**
 * Parse a novel yaml (src/content/novels/*.yaml): flat `key: value` scalars,
 * one `tags:` list (inline `[a, b]` or block `- item` form), and `>-`/`|`
 * block scalars. Tolerant and minimal like parseFrontmatter — full YAML
 * fidelity is zod's job at build time; lint only needs `slug` and `tags`.
 * Throws an Error naming the line when nothing matches the expected shape.
 */
export function parseNovelYaml(text) {
	const lines = text.split(/\r?\n/);
	const data = {};
	let i = 0;

	const takeIndented = () => {
		const collected = [];
		while (i < lines.length && (lines[i].trim() === '' || /^[ \t]+\S/.test(lines[i]))) {
			if (lines[i].trim() !== '') collected.push(lines[i]);
			i++;
		}
		return collected;
	};

	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === '' || /^\s*#/.test(line)) {
			i++;
			continue;
		}
		const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!keyMatch) {
			throw new Error(`novel yaml unparseable at "${line.trim()}"`);
		}
		const key = keyMatch[1];
		const rest = keyMatch[2].trim();
		i++;

		if (rest === '>' || rest === '>-' || rest === '|' || rest === '|-') {
			data[key] = takeIndented().map((l) => l.trim()).join(' ').trim();
		} else if (rest === '') {
			// Block list (`- item` lines), nested mapping, or a bare null.
			const nested = takeIndented();
			if (nested.length === 0) {
				data[key] = null;
			} else if (nested.every((l) => /^\s*-\s/.test(l))) {
				data[key] = nested.map((l) => coerceScalar(l.replace(/^\s*-\s*/, '')));
			} else if (nested.every((l) => /^\s+[A-Za-z0-9_-]+:(\s|$)/.test(l))) {
				const obj = {};
				for (const nestedLine of nested) {
					const nestedMatch = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(nestedLine);
					obj[nestedMatch[1]] = coerceScalar(nestedMatch[2]);
				}
				data[key] = obj;
			} else {
				data[key] = nested.map((l) => l.trim()).join(' ');
			}
		} else if (rest.startsWith('[') && rest.endsWith(']')) {
			data[key] = rest
				.slice(1, -1)
				.split(',')
				.map((s) => coerceScalar(s))
				.filter((s) => s !== '');
		} else {
			data[key] = coerceScalar(rest);
		}
	}

	return data;
}

/** Whitespace-token word count. HTML comments are invisible to readers —
 * they do not count (a comment can otherwise inflate a chapter past the
 * minimum and honesty checks). */
export function countWords(text) {
	return text
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.split(/\s+/)
		.filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

const REQUIRED_KEYS = ['novel', 'number', 'title', 'pubDate', 'wordCount'];
const PROVENANCE_FIELDS = ['writer', 'editor', 'proof', 'costInr', 'genSeconds'];
const PROVENANCE_STRING_FIELDS = new Set(['writer', 'editor', 'proof']);

function walkMarkdownFiles(dir) {
	const files = [];
	if (!existsSync(dir)) return files;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walkMarkdownFiles(full));
		else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
	}
	return files;
}

/** Parsed novel yamls: { name, data } entries; data is null when unparseable. */
function readNovels(novelsDir) {
	if (!existsSync(novelsDir)) return [];
	return readdirSync(novelsDir)
		.filter((f) => f.endsWith('.yaml'))
		.sort()
		.map((name) => {
			try {
				return { name, data: parseNovelYaml(readFileSync(path.join(novelsDir, name), 'utf8')) };
			} catch (err) {
				return { name, data: null, error: err.message };
			}
		});
}

/** Extra hint when a value that should be a number arrived quoted —
 * quoted numerics pass lenient parsing but fail the zod build schema. */
function quotedNumberHint(value) {
	if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
		return ' (quoted number — remove the quotes; the build schema requires a real number)';
	}
	return '';
}

/**
 * Lint every novel yaml in `novelsDir`: slug present, slug charset, slug
 * equal to the file stem (the site keys everything off the yaml slug —
 * chapter `novel:` refs, URLs, and vote ids — so a mismatch silently drops
 * the whole novel), and tag charset (tags become URL path segments).
 * Returns { count, errors } where each error is { path, message } with the
 * path relative to `novelsDir`.
 */
export function lintNovels(novelsDir) {
	const errors = [];
	const novels = readNovels(novelsDir);
	for (const novel of novels) {
		const fail = (message) => errors.push({ path: novel.name, message });
		if (novel.data == null) {
			fail(novel.error);
			continue;
		}
		const stem = novel.name.slice(0, -'.yaml'.length);
		const slug = novel.data.slug;
		if (slug === undefined || slug === null || String(slug).trim() === '') {
			fail("frontmatter key 'slug' is missing or empty");
		} else {
			if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
				fail(`slug '${slug}' must be lowercase kebab-case (a-z, 0-9, hyphens)`);
			}
			if (slug !== stem) {
				fail(`slug '${slug}' does not equal its file stem '${stem}' — the site resolves chapters, URLs, and vote ids by the yaml slug, so every chapter of this novel would be dropped`);
			}
		}
		const tags = novel.data.tags;
		if (tags !== undefined && tags !== null) {
			if (!Array.isArray(tags)) {
				fail(`tags must be a list, got ${JSON.stringify(tags)}`);
			} else {
				for (const tag of tags) {
					if (typeof tag !== 'string' || !SLUG_RE.test(tag)) {
						fail(`tag '${tag}' must be lowercase kebab-case (a-z, 0-9, hyphens) — tags become URL path segments`);
					}
				}
			}
		}
	}
	return { count: novels.length, errors };
}

/**
 * Lint every chapter markdown file under `chaptersDir` (recursively).
 * `novelsDir` supplies the set of valid `novel:` slugs — the yaml `slug:`
 * field, which lintNovels forces equal to the file stem.
 * Returns { count, errors } where each error is { path, message } with the
 * path relative to `chaptersDir`.
 */
export function lintChapters(chaptersDir, novelsDir) {
	const errors = [];
	const files = walkMarkdownFiles(chaptersDir).sort();
	const novelSlugs = new Set(
		readNovels(novelsDir)
			.filter((n) => n.data != null && typeof n.data.slug === 'string' && n.data.slug !== '')
			.map((n) => n.data.slug)
	);
	const seen = new Map(); // `${novel}#${number}` -> first path that used it

	for (const file of files) {
		const relPath = path.relative(chaptersDir, file).split(path.sep).join('/');
		const fail = (message) => errors.push({ path: relPath, message });

		let data;
		let bodyText = '';
		try {
			({ data, body: bodyText } = parseFrontmatter(readFileSync(file, 'utf8')));
		} catch (err) {
			fail(err.message);
			continue;
		}

		for (const key of REQUIRED_KEYS) {
			if (data[key] === undefined || data[key] === null) {
				fail(`frontmatter key '${key}' is missing`);
			}
		}

		const numberOk = Number.isInteger(data.number);
		const wordCountOk = Number.isInteger(data.wordCount);
		const novelOk = typeof data.novel === 'string' && data.novel.trim() !== '';
		if (data.number != null && !numberOk) {
			fail(
				`frontmatter key 'number' must be an integer, got ${JSON.stringify(data.number)}${quotedNumberHint(data.number)}`
			);
		}
		if (data.wordCount != null && !wordCountOk) {
			fail(
				`frontmatter key 'wordCount' must be an integer, got ${JSON.stringify(data.wordCount)}${quotedNumberHint(data.wordCount)}`
			);
		}
		if (data.novel != null && !novelOk) {
			fail(`frontmatter key 'novel' must be a non-empty string, got ${JSON.stringify(data.novel)}`);
		}

		// Check 7: pubDate parseable as a Date.
		if (typeof data.pubDate === 'string') {
			if (Number.isNaN(new Date(data.pubDate).getTime())) {
				fail(`pubDate '${data.pubDate}' is not a parseable date`);
			}
		} else if (data.pubDate != null) {
			fail(`frontmatter key 'pubDate' must be a date string, got ${JSON.stringify(data.pubDate)}`);
		}

		// Check 1: wordCount floor.
		if (wordCountOk && data.wordCount < MIN_WORDS) {
			fail(`wordCount ${data.wordCount} is below the ${MIN_WORDS}-word chapter minimum`);
		}

		// Check 2: wordCount honesty vs the markdown body.
		if (wordCountOk) {
			const actual = countWords(bodyText);
			const drift = Math.abs(data.wordCount - actual);
			if (drift > HONESTY_TOLERANCE * actual) {
				fail(
					`wordCount ${data.wordCount} is dishonest: body has ${actual} words ` +
						`(drift ${drift} > ${HONESTY_TOLERANCE * 100}% of actual)`
				);
			}
		}

		// Check 3: provenance present with all 5 fields, non-empty.
		const provenance = data.provenance;
		if (provenance == null || typeof provenance !== 'object' || Array.isArray(provenance)) {
			fail(`frontmatter key 'provenance' is missing or not a mapping`);
		} else {
			for (const field of PROVENANCE_FIELDS) {
				const value = provenance[field];
				if (value === undefined || value === null) {
					fail(`provenance field '${field}' is missing`);
				} else if (PROVENANCE_STRING_FIELDS.has(field)) {
					if (String(value).trim() === '') fail(`provenance field '${field}' is empty`);
				} else if (typeof value !== 'number') {
					fail(
						`provenance field '${field}' must be a number, got ${JSON.stringify(value)}${quotedNumberHint(value)}`
					);
				}
			}
		}

		// Check 4: novel ref resolves against a novels/*.yaml `slug:` value
		// (the same field the site's routes and vote ids key off).
		if (novelOk && !novelSlugs.has(data.novel)) {
			fail(`novel '${data.novel}' matches no novels/*.yaml slug (expected a file whose \`slug:\` is '${data.novel}')`);
		}

		// Check 5: duplicate (novel, number) pair.
		if (novelOk && numberOk) {
			const pairKey = `${data.novel}#${data.number}`;
			const first = seen.get(pairKey);
			if (first !== undefined) {
				fail(`duplicate chapter number ${data.number} for novel '${data.novel}' (already used by ${first})`);
			} else {
				seen.set(pairKey, relPath);
			}
		}

		// Check 6: filename is the chapter number zero-padded to 3 digits.
		if (numberOk) {
			const expected = `${String(data.number).padStart(3, '0')}.md`;
			const actualName = path.basename(file);
			if (actualName !== expected) {
				fail(`filename '${actualName}' does not match number ${data.number} (expected '${expected}')`);
			}
		}
	}

	return { count: files.length, errors };
}

// ---------------------------------------------------------------------------
// CLI — runs only when invoked directly.
// ---------------------------------------------------------------------------

function main() {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const chaptersDir = path.join(repoRoot, 'src', 'content', 'chapters');
	const novelsDir = path.join(repoRoot, 'src', 'content', 'novels');

	if (!existsSync(chaptersDir)) {
		console.error(`lint-content: chapters directory not found: ${chaptersDir}`);
		process.exitCode = 1;
		return;
	}

	const novelLint = lintNovels(novelsDir);
	const chapterLint = lintChapters(chaptersDir, novelsDir);
	const errors = [
		...novelLint.errors.map((e) => ({ base: path.relative(repoRoot, novelsDir), ...e })),
		...chapterLint.errors.map((e) => ({ base: path.relative(repoRoot, chaptersDir), ...e })),
	];
	if (errors.length > 0) {
		for (const { base, path: relPath, message } of errors) {
			console.error(`${path.join(base, relPath)}: ${message}`);
		}
		console.error(
			`lint-content: ${errors.length} error(s) across ${novelLint.count} novel(s) and ${chapterLint.count} chapter(s)`
		);
		process.exitCode = 1;
		return;
	}
	console.log(`OK: ${novelLint.count} novels and ${chapterLint.count} chapters checked`);
}

const invokedDirectly =
	process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main();
