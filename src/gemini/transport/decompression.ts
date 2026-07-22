type SupportedCompressionFormat = "gzip";

type SocketDecompressionStream = ReadableWritablePair<Uint8Array, Uint8Array>;

type SocketCompressionContract = {
	readonly acceptEncoding: "gzip" | "identity";
	readonly gzipDecoder: SocketDecompressionStream | null;
};

export function resolveSocketCompression(
	acceptCompressed: boolean,
): SocketCompressionContract {
	if (!acceptCompressed) return identityCompressionContract();
	try {
		if (typeof DecompressionStream !== "function")
			return identityCompressionContract();
		return {
			acceptEncoding: "gzip",
			gzipDecoder: new DecompressionStream(
				"gzip",
			) as unknown as SocketDecompressionStream,
		};
	} catch (_) {
		return identityCompressionContract();
	}
}

function contentDecompressionFormat(
	raw: string | null,
): SupportedCompressionFormat | null {
	const value = String(raw || "")
		.trim()
		.toLowerCase();
	if (value === "gzip" || value === "x-gzip") return "gzip";
	return null;
}

export function maybeDecompressSocketBody(
	stream: ReadableStream<Uint8Array>,
	headers: Headers,
	noBody: boolean,
	contentLength: number | null,
	compression: SocketCompressionContract,
): ReadableStream<Uint8Array> {
	const decompressionFormat =
		noBody || contentLength === 0
			? null
			: contentDecompressionFormat(headers.get("content-encoding"));
	if (!decompressionFormat || !compression.gzipDecoder) return stream;
	headers.delete("content-encoding");
	headers.delete("content-length");
	return stream.pipeThrough(compression.gzipDecoder);
}

function identityCompressionContract(): SocketCompressionContract {
	return { acceptEncoding: "identity", gzipDecoder: null };
}
