/**
 * Worker entry (plan P4) — thin wiring only; all logic lives in worker/votes.js.
 *
 * `wrangler.jsonc` routes `/api/*` to this Worker (`run_worker_first`);
 * every other path is served straight from static assets via `env.ASSETS`.
 */
import { handleApiRequest } from './votes.js';

/**
 * Real Turnstile siteverify adapter (mocked in unit tests).
 * @param {{ token: string, ip: string, secret: string }} params
 * @returns {Promise<{ success: boolean }>}
 */
async function turnstileSiteVerify({ token, ip, secret }) {
	try {
		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ secret, response: token, remoteip: ip }),
		});
		const data = await res.json();
		return { success: data?.success === true };
	} catch {
		// Network/edge failure verifying: fail closed.
		return { success: false };
	}
}

export default {
	/**
	 * @param {Request} request
	 * @param {{ ASSETS: { fetch(request: Request): Promise<Response> }, VOTES: import('./votes.js').KVNamespaceLike, TURNSTILE_SECRET?: string }} env
	 * @param {ExecutionContext} _ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, _ctx) {
		const apiResponse = await handleApiRequest(request, {
			kv: env.VOTES,
			turnstileVerify: turnstileSiteVerify,
			ip: request.headers.get('cf-connecting-ip') ?? '',
			secret: env.TURNSTILE_SECRET,
		});
		if (apiResponse) return apiResponse;
		return env.ASSETS.fetch(request);
	},
};
