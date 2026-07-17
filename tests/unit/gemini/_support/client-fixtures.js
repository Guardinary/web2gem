export function baseGeminiClientConfig(overrides = {}) {
	return {
		gemini_origin: "https://gemini.example",
		gemini_bl: "boq_test",
		cookie: "",
		sapisid: "",
		request_timeout_sec: 180,
		retry_attempts: 1,
		retry_delay_sec: 0,
		current_input_file_min_bytes: 1000000,
		upstream_socket: false,
		log_requests: false,
		...overrides,
	};
}
