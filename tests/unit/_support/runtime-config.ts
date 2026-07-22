type TestRuntimeConfig = {
	default_model: string;
	current_input_file_enabled: boolean;
	current_input_file_min_bytes: number;
	generic_file_upload_max_bytes: number;
	request_body_max_bytes: number;
	cookie: string;
	log_requests: boolean;
	[key: string]: unknown;
};

export function baseConfig(
	overrides: Partial<TestRuntimeConfig> = {},
): TestRuntimeConfig {
	return {
		default_model: "gemini-3.5-flash",
		current_input_file_enabled: false,
		current_input_file_min_bytes: 1000000,
		generic_file_upload_max_bytes: 20 * 1024 * 1024,
		request_body_max_bytes: 16 * 1024 * 1024,
		cookie: "",
		log_requests: false,
		...overrides,
	};
}
