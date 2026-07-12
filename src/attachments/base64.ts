export function base64DecodedByteLength(raw: string): number {
	const compact = String(raw || "").replace(/\s+/g, "");
	if (!compact) return 0;
	return Math.floor((compact.replace(/=+$/, "").length * 3) / 4);
}

export function validateBase64Shape(raw: unknown): string {
	const compact = String(raw || "").replace(/\s+/g, "");
	if (
		compact &&
		(!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) ||
			compact.length % 4 === 1 ||
			/=(?=.*[^=])/.test(compact))
	)
		throw new Error("invalid base64 payload");
	return compact;
}

export function base64ToBytes(value: unknown): Uint8Array {
	const source = String(value || "");
	const nativeFromBase64 = (Uint8Array as Uint8ArrayBase64Constructor)
		.fromBase64;
	if (typeof nativeFromBase64 === "function") {
		try {
			return nativeFromBase64(
				source,
				/[-_]/.test(source) ? { alphabet: "base64url" } : undefined,
			);
		} catch (_) {
			throw new Error("invalid base64 payload");
		}
	}
	const compact = validateBase64Shape(source);
	const standard = /[-_]/.test(compact)
		? compact.replace(/-/g, "+").replace(/_/g, "/")
		: compact;
	const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++)
		bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
	const nativeToBase64 = (bytes as Uint8ArrayBase64).toBase64;
	if (typeof nativeToBase64 === "function") return nativeToBase64.call(bytes);
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

type Uint8ArrayBase64Alphabet = "base64" | "base64url";
type Uint8ArrayBase64Constructor = typeof Uint8Array & {
	fromBase64?: (
		value: string,
		options?: { alphabet?: Uint8ArrayBase64Alphabet },
	) => Uint8Array;
};
type Uint8ArrayBase64 = Uint8Array & {
	toBase64?: (options?: {
		alphabet?: Uint8ArrayBase64Alphabet;
		omitPadding?: boolean;
	}) => string;
};
