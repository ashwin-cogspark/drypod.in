/**
 * Vote API core (plan P4) — plain ESM JavaScript with JSDoc types.
 *
 * Everything Cloudflare-specific (real KV binding, siteverify fetch, request
 * headers) is injected, so node:test runs this module directly with mocks:
 * `node --test worker/`. The thin Worker wiring lives in worker/index.js.
 *
 * KV layout:
 *   vote:<id>   -> JSON string `{"up":N,"down":N}` (missing = zero state)
 *   dedup:<hex> -> existence marks an ip+id that already voted;
 *                  hex = sha256("<ip>|<id>"), TTL = 10 years (per plan P4.4)
 */

/** @typedef {{ get(key: string): Promise<string|null>, put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> }} KVNamespaceLike */

/** @typedef {{ success: boolean }} TurnstileOutcome */

/** Verify a Turnstile token; real implementation in worker/index.js. @callback TurnstileVerify */
/** @param {{ token: string, ip: string, secret: string }} params @returns {Promise<TurnstileOutcome>} */

/** SHA-256 digest helper; injectable for tests. @callback Digest */
/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */

/** @typedef {{ method: string, url: string, headers: { get(name: string): string|null }, text(): Promise<string> }} RequestLike */

/**
 * @typedef {Object} HandleDeps
 * @property {KVNamespaceLike} kv                            injected KV namespace
 * @property {string} [ip]                                   client ip (cf-connecting-ip)
 * @property {string} [secret]                               env.TURNSTILE_SECRET (unset or test key = dev mode)
 * @property {TurnstileVerify} [turnstileVerify]             siteverify adapter
 * @property {Digest} [digest]                               sha256 digest, injectable
 */

export const VOTE_ID_PATTERN = /^(novel|chapter):[a-z0-9-]+(:\d{3,})?$/;
/** Longest id accepted — well under the 512-byte KV key limit. */
export const MAX_VOTE_ID_LENGTH = 128;
/** Public Turnstile secret that always passes — treated as dev mode (skip verify). */
export const DEV_TEST_SECRET = '1x00000000000000000000AA';
/** Dedup memory: 10 years (plan P4.4). */
export const DEDUP_TTL_SECONDS = 315360000;
/** Bulk GET exists for the nightly feedback sync; cap ids per request. */
export const BULK_MAX_IDS = 100;

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

/**
 * @param {object} body
 * @param {number} [status]
 * @returns {Response}
 */
function json(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** @param {string} id @returns {boolean} */
export function isValidVoteId(id) {
	return (
		typeof id === 'string' && id.length <= MAX_VOTE_ID_LENGTH && VOTE_ID_PATTERN.test(id)
	);
}

/** Default digest via Web Crypto (present in Workers runtime and Node >= 18).
 * @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
async function defaultDigest(bytes) {
	return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/** sha256(text) as lowercase hex.
 * @param {string} text @param {Digest} [digest] @returns {Promise<string>} */
export async function sha256Hex(text, digest = defaultDigest) {
	const bytes = await digest(new TextEncoder().encode(text));
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Dedup KV key for an ip+id pair.
 * @param {string} ip @param {string} id @param {Digest} [digest] @returns {Promise<string>} */
export function dedupKeyFor(ip, id, digest) {
	return sha256Hex(`${ip}|${id}`, digest).then((hex) => `dedup:${hex}`);
}

/** Read a tally, defaulting to zeros for missing/corrupt entries.
 * @param {KVNamespaceLike} kv @param {string} id @returns {Promise<{up: number, down: number}>} */
export async function readTally(kv, id) {
	const raw = await kv.get(`vote:${id}`);
	if (raw == null) return { up: 0, down: 0 };
	try {
		const parsed = JSON.parse(raw);
		return {
			up: Number.isFinite(parsed.up) ? parsed.up : 0,
			down: Number.isFinite(parsed.down) ? parsed.down : 0,
		};
	} catch {
		return { up: 0, down: 0 };
	}
}

/** Apply one vote and persist the new tally (read-modify-write; Durable Object later, per plan).
 * @param {KVNamespaceLike} kv @param {string} id @param {'up'|'down'} direction
 * @returns {Promise<{up: number, down: number}>} new counts */
export async function applyVote(kv, id, direction) {
	const tally = await readTally(kv, id);
	tally[direction] += 1;
	await kv.put(`vote:${id}`, JSON.stringify(tally));
	return tally;
}

/** Parse a bulk `ids=a,b,c` query value.
 * @param {string|null} queryValue
 * @returns {{ ids: string[], error: null } | { ids: null, error: 'missing_ids'|'invalid_id'|'too_many_ids' }} */
export function parseBulkIds(queryValue) {
	if (!queryValue) return { ids: null, error: 'missing_ids' };
	const ids = [...new Set(queryValue.split(',').map((s) => s.trim()).filter(Boolean))];
	if (ids.length === 0) return { ids: null, error: 'missing_ids' };
	if (ids.some((id) => !isValidVoteId(id))) return { ids: null, error: 'invalid_id' };
	if (ids.length > BULK_MAX_IDS) return { ids: null, error: 'too_many_ids' };
	return { ids, error: null };
}

/** POST /api/votes/:id — validate, verify, dedup, tally.
 * @param {RequestLike} request @param {string} id @param {HandleDeps} deps
 * @returns {Promise<Response>} */
async function postVote(request, id, deps) {
	// P4.8: a dedicated agent-vote lane (token-authenticated, no Turnstile) is
	// planned but DISABLED in v1 — refuse agent traffic explicitly rather than
	// routing it through the human flow.
	if (request.headers.get('x-agent-token') != null) {
		return json({ error: 'agent_voting_not_available' }, 501);
	}

	if (!isValidVoteId(id)) return json({ error: 'invalid_id' }, 400);

	let body;
	try {
		body = JSON.parse(await request.text());
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}
	if (body?.direction !== 'up' && body?.direction !== 'down') {
		return json({ error: 'invalid_direction' }, 400);
	}

	// Dev mode: no secret, or the public always-pass test secret — skip verify.
	// Real secret: the injected verifier calls siteverify.
	const { secret } = deps;
	if (secret && secret !== DEV_TEST_SECRET) {
		const outcome = await deps.turnstileVerify({
			token: typeof body.turnstileToken === 'string' ? body.turnstileToken : '',
			ip: deps.ip ?? '',
			secret,
		});
		if (!outcome?.success) return json({ error: 'turnstile_failed' }, 403);
	}

	const dedupKey = await dedupKeyFor(deps.ip ?? '', id, deps.digest);
	if ((await deps.kv.get(dedupKey)) != null) {
		return json({ error: 'already_voted' }, 409);
	}

	const tally = await applyVote(deps.kv, id, body.direction);
	await deps.kv.put(dedupKey, '1', { expirationTtl: DEDUP_TTL_SECONDS });
	return json(tally);
}

/** GET /api/votes/bulk?ids=a,b,c — counts per id for the nightly sync.
 * @param {URL} url @param {HandleDeps} deps @returns {Promise<Response>} */
async function getBulk(url, deps) {
	const parsed = parseBulkIds(url.searchParams.get('ids'));
	if (parsed.error) return json({ error: parsed.error }, 400);
	const out = {};
	for (const id of parsed.ids) out[id] = await readTally(deps.kv, id);
	return json(out);
}

/** Route /api/* requests. Returns null for non-API paths so the Worker
 * wiring (worker/index.js) can fall through to static assets.
 * @param {RequestLike} request @param {HandleDeps} deps
 * @returns {Promise<Response|null>} */
export async function handleApiRequest(request, deps) {
	const url = new URL(request.url);
	if (!url.pathname.startsWith('/api/')) return null;

	if (url.pathname === '/api/votes/bulk') {
		return request.method === 'GET'
			? getBulk(url, deps)
			: json({ error: 'method_not_allowed' }, 405);
	}

	const match = /^\/api\/votes\/([^/]+)$/.exec(url.pathname);
	if (match) {
		let id;
		try {
			id = decodeURIComponent(match[1]);
		} catch {
			// Malformed percent-encoding (e.g. /api/votes/%FF) — must not 500.
			return json({ error: 'invalid_id' }, 400);
		}
		if (request.method === 'GET') {
			if (!isValidVoteId(id)) return json({ error: 'invalid_id' }, 400);
			return json(await readTally(deps.kv, id));
		}
		if (request.method === 'POST') {
			return postVote(request, id, deps);
		}
		return json({ error: 'method_not_allowed' }, 405);
	}

	return json({ error: 'not_found' }, 404);
}
