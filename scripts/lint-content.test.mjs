// Unit tests for scripts/lint-content.mjs — node:test only, no new deps.
// Fixtures are written to a temp dir and cleaned up after each test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lintChapters, parseFrontmatter, countWords } from './lint-content.mjs';

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

/** Temp content tree: novels/<slug>.yaml files + chapter files under chapters/. */
async function makeRepo(chapters, novels = ['alpha']) {
	const root = await mkdtemp(path.join(tmpdir(), 'lint-content-'));
	const novelsDir = path.join(root, 'novels');
	const chaptersDir = path.join(root, 'chapters');
	await mkdir(novelsDir, { recursive: true });
	await mkdir(chaptersDir, { recursive: true });
	for (const slug of novels) {
		await writeFile(path.join(novelsDir, `${slug}.yaml`), `slug: ${slug}\n`);
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
