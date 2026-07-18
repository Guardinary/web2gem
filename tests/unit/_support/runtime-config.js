export function baseConfig(overrides = {}) {
	return {
		default_model: "gemini-3.5-flash",
		current_input_file_enabled: false,
		current_input_file_min_bytes: 1000000,
		current_input_file_name: "message.txt",
		current_tools_file_name: "tools.txt",
		generic_file_upload_max_bytes: 20 * 1024 * 1024,
		request_body_max_bytes: 16 * 1024 * 1024,
		cookie: "",
		log_requests: false,
		...overrides,
	};
}
