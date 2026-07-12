import { bytesToHex } from "../shared/crypto";
import { TEXT_ENCODER } from "../shared/encoding";

export let _sapisidHashCache: { key: string; value: string } = {
	key: "",
	value: "",
};

export async function makeSapisidHash(sapisid: string): Promise<string> {
	const timestamp = Math.floor(Date.now() / 1000);
	const cacheKey = `${timestamp}\x00${sapisid}`;
	if (_sapisidHashCache.key === cacheKey) return _sapisidHashCache.value;
	const data = TEXT_ENCODER.encode(
		`${timestamp} ${sapisid} https://gemini.google.com`,
	);
	const digest = await crypto.subtle.digest("SHA-1", data);
	const value = `SAPISIDHASH ${timestamp}_${bytesToHex(new Uint8Array(digest))}`;
	_sapisidHashCache = { key: cacheKey, value };
	return value;
}
