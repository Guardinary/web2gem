export const TEXT_ENCODER = new TextEncoder();
export const TEXT_DECODER = new TextDecoder();
export const UTF8_FATAL_DECODER = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: false,
});
