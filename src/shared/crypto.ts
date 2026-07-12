export function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
	const nativeToHex = (bytes as Uint8Array & { toHex?: () => string }).toHex;
	if (typeof nativeToHex === "function") return nativeToHex.call(bytes);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function randHex(length: number): string {
	return bytesToHex(randomBytes(Math.ceil(length / 2))).slice(0, length);
}

export function uuid(): string {
	return crypto.randomUUID();
}
