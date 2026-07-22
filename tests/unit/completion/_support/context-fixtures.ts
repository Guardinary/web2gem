import {
	createRuntimeConfig,
	getConfig,
	type RuntimeConfig,
} from "../../../../src/config";

export type RecordedUpload = { text: string; filename: string };

export function contextFileConfig(
	overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
	return {
		...createRuntimeConfig(getConfig()),
		current_input_file_enabled: true,
		current_input_file_min_bytes: 10,
		cookie: "SID=ok",
		supports_authenticated_session: true,
		log_requests: false,
		...overrides,
	};
}

export function recordedUploadAt(
	uploads: readonly RecordedUpload[],
	index: number,
): RecordedUpload {
	const upload = uploads[index];
	if (!upload) throw new Error(`expected upload at index ${index}`);
	return upload;
}
