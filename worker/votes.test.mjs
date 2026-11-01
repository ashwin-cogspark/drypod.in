/**
 * Unit tests for the vote API core (worker/votes.js).
 *
 * The core is plain ESM JavaScript with injected dependencies (KV store,
 * Turnstile verifier, digest, client IP), so node:test can run it directly —
 * no wrangler, no network, no build step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	handleApiRequest,
	isValidVoteId,
	parseBulkIds,
	applyVote,
	BULK_MAX_IDS,
	DEDUP_TTL_SECONDS,
	MAX_VOTE_ID_LENGTH,
} from './votes.js';

/* ---------------------------------------------------------------- helpers */

/** Minimal Request-shaped object (method/url/headers.get/text). */
function req(method, path, { body, headers = {} } = {}) {
	return {
		method,
		url: `https://drypod.in${path}`,
		headers: {
			get(name) {
				const hit = Object.entries(headers).find(
					([k]) => k.toLowerCase() === name.toLowerCase(),
				);
				return hit ? hit[1] : null;
			},
		},
		text: async () => body ?? '',
	};
}

/** In-memory KV namespace mock: get/put with expirationTtl capture. */
function makeKV() {
	const store = new Map();
	return {
		store,
		async get(key) {
			return store.has(key) ? store.get(key).value : null;
		},
		async put(key, value, opts = {}) {
			store.set(key, { value, ttl: opts.expirationTtl ?? null });
		},
	};
}

/** Mock Turnstile verifier that records calls and returns a fixed outcome. */
function makeTurnstile(success) {
	const calls = [];
	return {
		calls,
		async verify(params) {
			calls.push(params);
			return { success };
		},
	};
}

const IP = '203.0.113.7';

/* ------------------------------------------------------- id / bulk parsing */

test('isValidVoteId accepts novel and chapter shapes', () => {
	assert.equal(isValidVoteId('novel:test-serial'), true);
	assert.equal(isValidVoteId('chapter:test-serial:001'), true);
	assert.equal(isValidVoteId('chapter:a1-b2:999'), true);
});

test('isValidVoteId rejects malformed ids', () => {
	assert.equal(isValidVoteId('poem:test-serial'), false); // wrong prefix
	assert.equal(isValidVoteId('novel:'), false); // empty slug
	assert.equal(isValidVoteId('chapter:x:1'), false); // chapter number not 3 digits
	assert.equal(isValidVoteId('chapter:x:12'), false); // chapter number not 3 digits
	assert.equal(isValidVoteId('novel:Test_Serial'), false); // bad charset
	assert.equal(isValidVoteId('chapter:x:001:extra'), false); // trailing segment
	assert.equal(isValidVoteId(''), false);
	assert.equal(isValidVoteId(null), false);
});

test('isValidVoteId accepts chapter numbers of 3 or more digits (chapter 1000+)', () => {
	assert.equal(isValidVoteId('chapter:test-serial:1000'), true);
	assert.equal(isValidVoteId('chapter:a-b:1234'), true);
	assert.equal(isValidVoteId('chapter:x:999'), true); // 3 digits still fine
});

test('isValidVoteId rejects ids longer than the KV-key-safe cap', () => {
	assert.equal(isValidVoteId(`novel:${'a'.repeat(MAX_VOTE_ID_LENGTH)}`), false);
	assert.equal(isValidVoteId(`novel:${'a'.repeat(MAX_VOTE_ID_LENGTH - 7)}`), true);
});

test('parseBulkIds splits, trims, drops empties, dedupes', () => {
	assert.deepEqual(parseBulkIds('novel:a, novel:b ,,novel:a,'), {
		ids: ['novel:a', 'novel:b'],
		error: null,
	});
	assert.deepEqual(parseBulkIds(''), { ids: null, error: 'missing_ids' });
	assert.deepEqual(parseBulkIds('novel:a,poem:x'), {
		ids: null,
		error: 'invalid_id',
	});
});

/* --------------------------------------------------------------- GET votes */

test('GET vote id with no KV entry returns zero counts as no-store JSON', async () => {
	const kv = makeKV();
	const res = await handleApiRequest(req('GET', '/api/votes/novel:test-serial'), {
		kv,
		ip: IP,
	});
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { up: 0, down: 0 });
	assert.equal(res.headers.get('content-type'), 'application/json');
	assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('GET with malformed percent-encoding in the id returns 400, not a 500', async () => {
	const kv = makeKV();
	const res = await handleApiRequest(req('GET', '/api/votes/%FF'), { kv, ip: IP });
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: 'invalid_id' });
	assert.equal(kv.store.size, 0);
});

test('GET with a malformed id returns 400 invalid_id like POST does', async () => {
	const kv = makeKV();
	const res = await handleApiRequest(req('GET', '/api/votes/poem:test-serial'), { kv, ip: IP });
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: 'invalid_id' });
	assert.equal(kv.store.size, 0);
});

test('GET with an oversized id returns 400 without touching KV', async () => {
	const kv = makeKV();
	const res = await handleApiRequest(req('GET', `/api/votes/novel:${'a'.repeat(500)}`), {
		kv,
		ip: IP,
	});
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: 'invalid_id' });
	assert.equal(kv.store.size, 0);
});

test('GET and POST work end to end for chapter numbers of 4 digits', async () => {
	const kv = makeKV();
	const read = () =>
		handleApiRequest(req('GET', '/api/votes/chapter:test-serial:1000'), { kv, ip: IP });
	assert.equal((await read()).status, 200);
	const res = await handleApiRequest(
		req('POST', '/api/votes/chapter:test-serial:1000', {
			body: JSON.stringify({ direction: 'up', turnstileToken: 'tok' }),
		}),
		{ kv, ip: IP },
	);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { up: 1, down: 0 });
});

/* -------------------------------------------------------------- POST votes */

test('POST up increments and returns new counts, persisting the tally', async () => {
	const kv = makeKV();
	const res = await handleApiRequest(
		req('POST', '/api/votes/novel:test-serial', {
			body: JSON.stringify({ direction: 'up', turnstileToken: 'tok' }),
		}),
		{ kv, ip: IP },
	);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { up: 1, down: 0 });
	assert.equal(kv.store.get('vote:novel:test-serial').value, '{"up":1,"down":0}');
});

test('POST down increments the down side', async () => {
	const kv = makeKV();
	const res = await handleApiRequest(
		req('POST', '/api/votes/chapter:test-serial:001', {
			body: JSON.stringify({ direction: 'down', turnstileToken: 'tok' }),
		}),
		{ kv, ip: IP },
	);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { up: 0, down: 1 });
});

test('second POST from same ip+id is deduped with 409 already_voted', async () => {
	const kv = makeKV();
	const post = () =>
		handleApiRequest(
			req('POST', '/api/votes/novel:test-serial', {
				body: JSON.stringify({ direction: 'up', turnstileToken: 'tok' }),
			}),
			{ kv, ip: IP },
		);
	assert.equal((await post()).status, 200);
	const second = await post();
	assert.equal(second.status, 409);
	assert.deepEqual(await second.json(), { error: 'already_voted' });
	// Tally unchanged by the blocked attempt.
	assert.equal(kv.store.get('vote:novel:test-serial').value, '{"up":1,"down":0}');
});

test('switching the vote direction is blocked by the same dedup key', async () => {
	const kv = makeKV();
	const post = (direction) =>
		handleApiRequest(
			req('POST', '/api/votes/novel:test-serial', {
				body: JSON.stringify({ direction, turnstileToken: 'tok' }),
			}),
			{ kv, ip: IP },
		);
	assert.equal((await post('up')).status, 200);
	const switched = await post('down');
	assert.equal(switched.status, 409);
	assert.deepEqual(await switched.json(), { error: 'already_voted' });
	assert.equal(kv.store.get('vote:novel:test-serial').value, '{"up":1,"down":0}');
});

test('a different ip can vote on the same id (dedup key includes ip)', async () => {
	const kv = makeKV();
	const post = (ip) =>
		handleApiRequest(
			req('POST', '/api/votes/novel:test-serial', {
				body: JSON.stringify({ direction: 'up', turnstileToken: 'tok' }),
			}),
			{ kv, ip },
		);
	await post('203.0.113.7');
	const res = await post('198.51.100.9');
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { up: 2, down: 0 });
});

test('POST with a malformed id returns 400 invalid_id', async () => {
	const kv = makeKV();
	const res = await handleApiRequest(
		req('POST', '/api/votes/poem:test-serial', {
			body: JSON.stringify({ direction: 'up' }),
		}),
		{ kv, ip: IP },
	);
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: 'invalid_id' });
});

test('POST with a bad or missing direction returns 400 invalid_direction', async () => {
	const kv = makeKV();
	for (const direction of ['sideways', '', undefined]) {
		const res = await handleApiRequest(
			req('POST', '/api/votes/novel:test-serial', {
				body: JSON.stringify({ direction, turnstileToken: 'tok' }),
			}),
			{ kv, ip: IP },
		);
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: 'invalid_direction' });
	}
	// Nothing was written.
	assert.equal(kv.store.size, 0);
});

test('POST with malformed JSON body returns 400 invalid_json', async () => {
	const kv = makeKV();
	const res = await handleApiRequest(
		req('POST', '/api/votes/novel:test-serial', { body: '{"direction": ' }),
		{ kv, ip: IP },
	);
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: 'invalid_json' });
});

/* ------------------------------------------------------------- Turnstile */

test('dev mode: unset secret skips turnstile verification entirely', async () => {
	const kv = makeKV();
	const ts = makeTurnstile(true);
	const res = await handleApiRequest(
		req('POST', '/api/votes/novel:test-serial', {
			body: JSON.stringify({ direction: 'up', turnstileToken: 'tok' }),
		}),
		{ kv, ip: IP, turnstileVerify: ts.verify },
	);
	assert.equal(res.status, 200);
	assert.equal(ts.calls.length, 0);
});

test('dev mode: public always-pass test secret skips verification', async () => {
	const kv = makeKV();
	const ts = makeTurnstile(true);
	const res = await handleApiRequest(
		req('POST', '/api/votes/novel:test-serial', {
			body: JSON.stringify({ direction: 'up', turnstileToken: 'tok' }),
		}),
		{
			kv,
			ip: IP,
			turnstileVerify: ts.verify,
			secret: '1x00000000000000000000AA',
		},
	);
	assert.equal(res.status, 200);
	assert.equal(ts.calls.length, 0);
});

test('real secret: passing verification lets the vote through with token+ip+secret', async () => {
	const kv = makeKV();
	const ts = makeTurnstile(true);
	const res = await handleApiRequest(
		req('POST', '/api/votes/novel:test-serial', {
			body: JSON.stringify({ direction: 'up', turnstileToken: 'tok-123' }),
		}),
		{ kv, ip: IP, turnstileVerify: ts.verify, secret: 'real-secret' },
	);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { up: 1, down: 0 });
	assert.deepEqual(ts.calls, [
		{ token: 'tok-123', ip: IP, secret: 'real-secret' },
	]);
});

test('real secret: failed verification returns 403 turnstile_failed and writes nothing', async () => {
	const kv = makeKV();
	const ts = makeTurnstile(false);
	const res = await handleApiRequest(
		req('POST', '/api/votes/novel:test-serial', {
			body: JSON.stringify({ direction: 'up', turnstileToken: 'tok' }),
		}),
		{ kv, ip: IP, turnstileVerify: ts.verify, secret: 'real-secret' },
	);
	assert.equal(res.status, 403);
	assert.deepEqual(await res.json(), { error: 'turnstile_failed' });
	assert.equal(kv.store.size, 0);
});

/* ------------------------------------------------------------- dedup keys */

test('dedup key is sha256(ip|id) using the injectable digest, written with 10-year TTL', async () => {
	const kv = makeKV();
	const inputs = [];
	const digest = async (bytes) => {
		inputs.push(new TextDecoder().decode(bytes));
		return new Uint8Array([0x01, 0x02, 0x03]);
	};
	const res = await handleApiRequest(
		req('POST', '/api/votes/novel:test-serial', {
			body: JSON.stringify({ direction: 'up', turnstileToken: 'tok' }),
		}),
		{ kv, ip: '1.2.3.4', digest },
	);
	assert.equal(res.status, 200);
	assert.deepEqual(inputs, ['1.2.3.4|novel:test-serial']);
	const entry = kv.store.get('dedup:010203');
	assert.ok(entry, 'dedup key dedup:010203 written');
	assert.equal(entry.ttl, DEDUP_TTL_SECONDS);
	assert.equal(DEDUP_TTL_SECONDS, 315360000); // 10 years, per plan
});

/* ------------------------------------------------------------------- bulk */

test('bulk GET returns counts per id, zeros for unknown ids', async () => {
	const kv = makeKV();
	await applyVote(kv, 'novel:a', 'up');
	await applyVote(kv, 'novel:a', 'up');
	await applyVote(kv, 'novel:a', 'down');
	const res = await handleApiRequest(
		req('GET', '/api/votes/bulk?ids=novel:a,novel:unknown-1'),
		{ kv, ip: IP },
	);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), {
		'novel:a': { up: 2, down: 1 },
		'novel:unknown-1': { up: 0, down: 0 },
	});
});

test(`bulk GET accepts at most ${BULK_MAX_IDS} ids`, async () => {
	const kv = makeKV();
	const ids = Array.from({ length: BULK_MAX_IDS }, (_, i) => `novel:cap-${i}`);
	const ok = await handleApiRequest(
		req('GET', `/api/votes/bulk?ids=${ids.join(',')}`),
		{ kv, ip: IP },
	);
	assert.equal(ok.status, 200);
	assert.equal(Object.keys(await ok.json()).length, BULK_MAX_IDS);

	const over = await handleApiRequest(
		req('GET', `/api/votes/bulk?ids=${[...ids, 'novel:one-more'].join(',')}`),
		{ kv, ip: IP },
	);
	assert.equal(over.status, 400);
	assert.deepEqual(await over.json(), { error: 'too_many_ids' });
});

test('bulk GET without ids param returns 400 missing_ids', async () => {
	const res = await handleApiRequest(req('GET', '/api/votes/bulk'), {
		kv: makeKV(),
		ip: IP,
	});
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: 'missing_ids' });
});

/* ------------------------------------------------------- routing / errors */

test('X-Agent-Token on POST returns 501 (agent lane disabled in v1)', async () => {
	const kv = makeKV();
	const res = await handleApiRequest(
		req('POST', '/api/votes/novel:test-serial', {
			body: JSON.stringify({ direction: 'up' }),
			headers: { 'X-Agent-Token': 'anything' },
		}),
		{ kv, ip: IP },
	);
	assert.equal(res.status, 501);
	assert.deepEqual(await res.json(), { error: 'agent_voting_not_available' });
	assert.equal(kv.store.size, 0);
});

test('wrong method on a vote id returns 405', async () => {
	const kv = makeKV();
	for (const method of ['DELETE', 'PUT', 'PATCH']) {
		const res = await handleApiRequest(req(method, '/api/votes/novel:a'), {
			kv,
			ip: IP,
		});
		assert.equal(res.status, 405);
	}
});

test('wrong method on bulk returns 405', async () => {
	const res = await handleApiRequest(req('POST', '/api/votes/bulk?ids=novel:a'), {
		kv: makeKV(),
		ip: IP,
	});
	assert.equal(res.status, 405);
});

test('unknown /api paths return 404', async () => {
	const kv = makeKV();
	for (const path of ['/api/nope', '/api/votes', '/api/votes/', '/api/votes/a/b']) {
		const res = await handleApiRequest(req('GET', path), { kv, ip: IP });
		assert.equal(res.status, 404, path);
		assert.deepEqual(await res.json(), { error: 'not_found' });
	}
});

test('non-API paths return null so the caller falls through to assets', async () => {
	const res = await handleApiRequest(req('GET', '/novels/test-serial/'), {
		kv: makeKV(),
		ip: IP,
	});
	assert.equal(res, null);
});
