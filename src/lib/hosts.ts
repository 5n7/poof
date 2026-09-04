/**
 * Read a config var that may be missing at runtime.
 *
 * `wrangler types` declares every `wrangler.jsonc` var as a required `string`,
 * but the binding is only present if the deployed config still carries it. A
 * var removed from `wrangler.jsonc`, or absent from a test env, arrives as
 * `undefined`, and `undefined.trim()` would be a `TypeError` and a 500 where
 * the fail-closed 503 belongs. Missing and blank collapse to the same "".
 */
export function configured(value: string | undefined): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * The characters that end an authority in a URL. A configured host containing
 * one is not a bare host, even when nothing follows it: `poof.5n7.me/` and
 * `poof.5n7.me?` parse to the same authority the bare name does, so accepting
 * them would let one var be written three ways that all name one host while
 * comparing unequal to each other.
 */
const AUTHORITY_DELIMITERS = /[\\/?#]/;

/**
 * The protocol `hostIdentity` parses with. Which one it is cannot change the
 * answer, because the port is discarded either way; it is fixed only so the
 * parse has a scheme to work with.
 */
const IDENTITY_PROTOCOL = "https:";

interface Authority {
	/** Lowercased, with the trailing DNS root label removed. */
	hostname: string;
	/** Empty when the port is the default for the protocol it was parsed with. */
	port: string;
}

/** Parse a bare authority, or `null` when the value is not one. */
function parseAuthority(authority: string | undefined, protocol: string): Authority | null {
	const raw = configured(authority);
	if (raw === "" || AUTHORITY_DELIMITERS.test(raw)) return null;

	let url: URL;
	try {
		url = new URL(`${protocol}//${raw}`);
	} catch {
		return null;
	}
	// Credentials need no delimiter to appear, so they are checked separately.
	if (url.username !== "" || url.password !== "") return null;

	const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
	return hostname === "" ? null : { hostname, port: url.port };
}

/**
 * The DNS identity of an authority: its hostname, with no port and no
 * dependence on the request's scheme.
 *
 * This is what decides whether `MCP_HOST` and `OWNER_HOST` name two hosts or
 * one. Comparing with the port included would leave the answer scheme-dependent
 * and the boundary open: `OWNER_HOST=example` against `MCP_HOST=example:443`
 * collapses to one host over HTTPS, where 443 is the default and drops, but
 * stays two distinct strings over HTTP, where it does not. One DNS name cannot
 * be two isolated surfaces on either scheme, so the port has no say here.
 */
export function hostIdentity(authority: string | undefined): string | null {
	return parseAuthority(authority, IDENTITY_PROTOCOL)?.hostname ?? null;
}

/**
 * An authority canonicalized for *routing*: the hostname plus any port that is
 * significant for `protocol`.
 *
 * Case and the trailing DNS root label normalize away, so `POOF.5N7.ME` and
 * `poof.5n7.me.` both match `poof.5n7.me`. A non-default port stays, which is
 * what lets `wrangler dev` serve `localhost:8787` and `127.0.0.1:8787` as two
 * surfaces from one process.
 */
export function canonicalHost(authority: string | undefined, protocol: string): string | null {
	const parsed = parseAuthority(authority, protocol);
	if (parsed === null) return null;
	return parsed.port === "" ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
}
