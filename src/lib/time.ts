/** Current Unix time in whole seconds (the unit used for all TTL/expiry logic). */
export function nowSeconds(): number {
	return (Date.now() / 1000) | 0;
}
