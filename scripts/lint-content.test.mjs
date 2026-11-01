// Unit tests for scripts/lint-content.mjs — node:test only, no new deps.
// Fixtures are written to a temp dir and cleaned up after each test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lintChapters, lintNovels, parseFrontmatter, parseNovelYaml, countWords } from './lint-content.mjs';

/** Body of exactly `n` whitespace-separated tokens. */
const body = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

/** Render the chapter frontmatter shape used by src/content/chapters. */
function frontmatter(fields = {}) {
	// `provenance: null` omits the block; undefined means "use the default".
	const hasProvenance = Object.hasOwn(fields, 'provenance');
	const p = hasProvenance
		? fields.provenance
		: {
				writer: 'human fixture',
				editor: 'human fixture',
				proof: 'human fixture',
				costInr: 0,
				genSeconds: 0,
			};
	const lines = [
		`novel: ${fields.novel ?? 'alpha'}`,
		`number: ${fields.number ?? 1}`,
		`title: ${fields.title ?? 'A Chapter'}`,
		`pubDate: ${fields.pubDate ?? '2026-10-29T06:00:00+05:30'}`,
		`wordCount: ${fields.wordCount ?? 900}`,
	];
	if (p !== null) {
		lines.push(
			'provenance:',
			`  writer: ${p.writer}`,
			`  editor: ${p.editor}`,
			`  proof: ${p.proof}`,
			`  costInr: ${p.costInr ?? 0}`,
			`  genSeconds: ${p.genSeconds ?? 0}`
		);
	}
	return lines.join('\n');
}

/** A full chapter file: frontmatter + honest-by-default body. */
function chapter(fields = {}, bodyWords = 900) {
	return `---\n${frontmatter(fields)}\n---\n\n${body(bodyWords)}\n`;
}

/** Temp content tree: novels/<slug>.yaml files + chapter files under chapters/.
 * `novels` entries are slug strings (rendered as `slug: <slug>`) or
 * `{ name, content }` objects for full control over the yaml. */
async function makeRepo(chapters, novels = ['alpha']) {
	const root = await mkdtemp(path.join(tmpdir(), 'lint-content-'));
	const novelsDir = path.join(root, 'novels');
	const chaptersDir = path.join(root, 'chapters');
	await mkdir(novelsDir, { recursive: true });
	await mkdir(chaptersDir, { recursive: true });
	for (const novel of novels) {
		const entry =
			typeof novel === 'string' ? { name: `${novel}.yaml`, content: `slug: ${novel}\n` } : novel;
		await writeFile(path.join(novelsDir, entry.name), entry.content);
	}
	for (const c of chapters) {
		const dir = path.join(chaptersDir, c.dir ?? 'alpha');
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, c.name), c.content);
	}
	return { root, chaptersDir, novelsDir };
}

test('valid chapter passes all checks', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '001.md', content: chapter() },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.deepEqual(result.errors, []);
	assert.equal(result.count, 1);
});

test('wordCount within the 10% honesty tolerance passes', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		// actual 900, declared 990 -> diff exactly 10%, still honest
		{ name: '001.md', content: chapter({ wordCount: 990 }) },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.deepEqual(result.errors, []);
});

test('chapter under 800 words is rejected', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '001.md', content: chapter({ wordCount: 700 }, 700) },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0].message, /800/);
	assert.equal(result.errors[0].path, 'alpha/001.md');
});

test('dishonest wordCount is rejected', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		// actual 900, declared 1000 -> 11.1% off, past tolerance
		{ name: '001.md', content: chapter({ wordCount: 1000 }) },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0].message, /wordCount/i);
	assert.match(result.errors[0].message, /900/);
});

test('words inside HTML comments do not count toward wordCount', async (t) => {
	const comment = `<!-- ${body(300)} -->`;
	const { chaptersDir, novelsDir, root } = await makeRepo([
		// 900 visible + 300 comment words; declaring 1200 counts the comment
		{ name: '001.md', content: `---\n${frontmatter({ wordCount: 1200 })}\n---\n\n${body(900)}\n${comment}\n` },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0].message, /dishonest/);
	assert.match(result.errors[0].message, /900/);
});

test('chapter with HTML comments and an honest visible-only wordCount passes', async (t) => {
	const comment = `<!-- ${body(300)} -->`;
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '001.md', content: `---\n${frontmatter({ wordCount: 900 })}\n---\n\n${body(900)}\n${comment}\n` },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	assert.deepEqual(lintChapters(chaptersDir, novelsDir).errors, []);
});

test('quoted numeric wordCount is rejected with a clear message', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '001.md', content: chapter({ wordCount: '"900"' }) },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0].message, /wordCount/);
	assert.match(result.errors[0].message, /quote/i); // tells the writer to unquote
});

test('quoted numeric number and provenance values are rejected', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{
			name: '001.md',
			content: chapter({ number: '"1"', provenance: { writer: 'w', editor: 'e', proof: 'p', costInr: '"0"', genSeconds: 0 } }),
		},
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	const messages = result.errors.map((e) => e.message);
	assert.ok(messages.some((m) => /'number'/.test(m) && /quote/i.test(m)));
	assert.ok(messages.some((m) => /costInr/.test(m) && /quote/i.test(m)));
});

test('missing provenance block is rejected', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '001.md', content: chapter({ provenance: null }) },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.ok(result.errors.length >= 1);
	assert.ok(result.errors.every((e) => /provenance/i.test(e.message)));
});

test('empty provenance field is rejected', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{
			name: '001.md',
			content: chapter({
				provenance: {
					writer: '',
					editor: 'human fixture',
					proof: 'human fixture',
					costInr: 0,
					genSeconds: 0,
				},
			}),
		},
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0].message, /writer/);
});

test('reference to unknown novel is rejected', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '001.md', content: chapter({ novel: 'ghost' }) },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0].message, /ghost/);
});

/* --------------------------------------------------------- novel yaml lint */

test('novel whose slug differs from its file stem is rejected', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo(
		[{ name: '001.md', content: chapter({ novel: 'mismatched-slug' }) }],
		[{ name: 'beta.yaml', content: 'slug: mismatched-slug\n' }]
	);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintNovels(novelsDir);
	assert.equal(result.count, 1);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0].message, /mismatched-slug/);
	assert.match(result.errors[0].message, /beta/);
	// The chapter itself is clean: it references the yaml slug, which the site
	// resolves by — the novel file is what is broken, not the chapter.
	assert.deepEqual(lintChapters(chaptersDir, novelsDir).errors, []);
});

test('novel slug with uppercase or underscore characters is rejected', async (t) => {
	const { novelsDir, root } = await makeRepo([], [
		{ name: 'my-novel.yaml', content: 'slug: My_Novel\n' },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintNovels(novelsDir);
	const messages = result.errors.map((e) => e.message);
	assert.equal(messages.length, 2); // charset + stem mismatch
	assert.ok(messages.some((m) => /My_Novel/.test(m) && /[a-z0-9]/.test(m) && /slug/i.test(m)));
	assert.ok(messages.some((m) => /my-novel/.test(m) && /stem|file/.test(m)));
});

test('novel tag outside the lowercase kebab charset is rejected', async (t) => {
	const { novelsDir, root } = await makeRepo([], [
		{ name: 'alpha.yaml', content: 'slug: alpha\ntags:\n  - cultivation\n  - Bad Tag\n' },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintNovels(novelsDir);
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0].path, 'alpha.yaml');
	assert.match(result.errors[0].message, /Bad Tag/);
});

test('novel with kebab slug and tags passes', async (t) => {
	const { novelsDir, root } = await makeRepo([], [
		{
			name: 'alpha.yaml',
			content: 'slug: alpha\ntags:\n  - cultivation\n  - system-1\nsynopsis: >-\n  Folded text\n',
		},
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	assert.deepEqual(lintNovels(novelsDir).errors, []);
});

test('chapter referencing a valid slug passes while stems and slugs agree', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo(
		[{ name: '001.md', content: chapter({ novel: 'alpha' }) }],
		['alpha']
	);
	t.after(() => rm(root, { recursive: true, force: true }));

	assert.deepEqual(lintNovels(novelsDir).errors, []);
	assert.deepEqual(lintChapters(chaptersDir, novelsDir).errors, []);
});

test('parseNovelYaml reads scalars, inline arrays, block lists, and folded blocks', () => {
	const data = parseNovelYaml(
		[
			'slug: alpha',
			'title: "A Title"',
			'tags: [cultivation, system]',
			'status: ongoing',
			'synopsis: >-',
			'  Folded synopsis that',
			'  spans two lines.',
		].join('\n')
	);
	assert.equal(data.slug, 'alpha');
	assert.equal(data.title, 'A Title');
	assert.deepEqual(data.tags, ['cultivation', 'system']);
	assert.equal(data.status, 'ongoing');
	assert.equal(data.synopsis, 'Folded synopsis that spans two lines.');

	const blockList = parseNovelYaml('slug: beta\ntags:\n  - one\n  - two\n');
	assert.deepEqual(blockList.tags, ['one', 'two']);
});

test('duplicate (novel, number) pair is rejected', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ dir: 'alpha', name: '001.md', content: chapter() },
		// same novel + number in another directory (e.g. a stale copy)
		{ dir: 'alpha-drafts', name: '001.md', content: chapter() },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.count, 2);
	const dup = result.errors.filter((e) => /duplicate/i.test(e.message));
	assert.equal(dup.length, 1);
	// 'alpha-drafts' sorts before 'alpha', so alpha/001.md is the flagged copy.
	assert.equal(dup[0].path, 'alpha/001.md');
	assert.match(dup[0].message, /alpha-drafts\/001\.md/);
});

test('filename not zero-padded to 3 digits is rejected', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '01.md', content: chapter({ number: 1 }) },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0].message, /01\.md/);
	assert.match(result.errors[0].message, /001\.md/);
});

test('missing frontmatter is rejected naming the file', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '001.md', content: `${body(900)}\n` },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0].path, 'alpha/001.md');
	assert.match(result.errors[0].message, /frontmatter/i);
});

test('unparseable frontmatter is rejected naming the file', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '001.md', content: `---\n[broken yaml\n---\n\n${body(900)}\n` },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0].path, 'alpha/001.md');
	assert.match(result.errors[0].message, /frontmatter/i);
});

test('missing required key is rejected naming the key', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '001.md', content: `---\nnovel: alpha\ntitle: A Chapter\n---\n\n${body(900)}\n` },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.ok(result.errors.length >= 3); // number, pubDate, wordCount
	for (const key of ['number', 'pubDate', 'wordCount']) {
		assert.ok(
			result.errors.some((e) => e.message.includes(`'${key}'`)),
			`expected an error naming '${key}'`
		);
	}
});

test('unparseable pubDate is rejected', async (t) => {
	const { chaptersDir, novelsDir, root } = await makeRepo([
		{ name: '001.md', content: chapter({ pubDate: 'not-a-date' }) },
	]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = lintChapters(chaptersDir, novelsDir);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0].message, /pubDate/);
});

test('parseFrontmatter handles nested blocks, coercion, and folded scalars', () => {
	const text = [
		'---',
		'novel: alpha',
		'number: 7',
		'title: "Quoted: Title"',
		'pubDate: 2026-10-29T06:00:00+05:30',
		'wordCount: 1050',
		'provenance:',
		'  writer: human fixture',
		'  editor: human fixture',
		'  proof: human fixture',
		'  costInr: 0',
		'  genSeconds: 0',
		'authorNote: >-',
		'  Folded note that',
		'  spans two lines.',
		'---',
		'',
		'Chapter body here.',
	].join('\n');

	const { data, body: bodyText } = parseFrontmatter(text);
	assert.equal(data.novel, 'alpha');
	assert.equal(data.number, 7);
	assert.equal(data.title, 'Quoted: Title');
	assert.equal(data.pubDate, '2026-10-29T06:00:00+05:30');
	assert.equal(data.wordCount, 1050);
	assert.deepEqual(data.provenance, {
		writer: 'human fixture',
		editor: 'human fixture',
		proof: 'human fixture',
		costInr: 0,
		genSeconds: 0,
	});
	assert.equal(data.authorNote, 'Folded note that spans two lines.');
	assert.equal(bodyText.trim(), 'Chapter body here.');
});

test('countWords is a whitespace-token count', () => {
	assert.equal(countWords('  a  b\nc  '), 3);
	assert.equal(countWords(''), 0);
	assert.equal(countWords('one'), 1);
});

test('countWords ignores HTML comments', () => {
	assert.equal(countWords('a <!-- b c d --> e'), 2);
	assert.equal(countWords('<!-- only a comment -->'), 0);
	assert.equal(countWords('a <!-- multi\nline\ncomment --> b'), 2);
});
