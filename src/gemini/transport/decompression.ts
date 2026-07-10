type SupportedCompressionFormat = "gzip";

export function socketAcceptEncoding(acceptCompressed: boolean): string {
	if (!acceptCompressed) return "identity";
	return "gzip";
}

export function contentDecompressionFormat(
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
): ReadableStream<Uint8Array> {
	const decompressionFormat =
		noBody || contentLength === 0
			? null
			: contentDecompressionFormat(headers.get("content-encoding"));
	if (!decompressionFormat) return stream;
	headers.delete("content-encoding");
	headers.delete("content-length");
	return stream.pipeThrough(
		new DecompressionStream(
			decompressionFormat,
		) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
	);
}
