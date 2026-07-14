import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { errorLine, outputLine } from "./io.mjs";

const benchmarkBundlePath = resolve(
	process.cwd(),
	process.env.BENCH_TEST_BUNDLE || "dist/worker.test.js",
);
let mod;
try {
	mod = await import(pathToFileURL(benchmarkBundlePath).href);
} catch (error) {
	errorLine(
		`Benchmark bundle load failed: ${benchmarkBundlePath}: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}

const ITERATIONS = positiveInt(process.env.BENCH_ITERS, 2000);
const JSON_OUTPUT = /^(1|true|yes|on)$/i.test(
	String(process.env.BENCH_JSON || ""),
);
const WARMUP = positiveInt(
	process.env.BENCH_WARMUP,
	Math.min(500, Math.floor(ITERATIONS / 4)),
);
const SSE_CHUNKS = positiveInt(process.env.BENCH_SSE_CHUNKS, 512);
const SSE_SLOW_CHUNKS = positiveInt(process.env.BENCH_SSE_SLOW_CHUNKS, 128);
const SSE_SLOW_DELAY_MS = positiveInt(process.env.BENCH_SSE_SLOW_DELAY_MS, 1);
const SOCKET_BODY_BYTES = positiveInt(
	process.env.BENCH_SOCKET_BODY_BYTES,
	64 * 1024,
);
const SOCKET_CHUNK_BYTES = positiveInt(
	process.env.BENCH_SOCKET_CHUNK_BYTES,
	1024,
);
const UNIQUE_ITEMS_COUNT = positiveInt(
	process.env.BENCH_UNIQUE_ITEMS_COUNT,
	240,
);
const BASE64_BYTES = positiveInt(process.env.BENCH_BASE64_BYTES, 64 * 1024);
const MULTIPART_BYTES = positiveInt(
	process.env.BENCH_MULTIPART_BYTES,
	8 * 1024 * 1024,
);
const APP_HTML_BYTES = positiveInt(
	process.env.BENCH_APP_HTML_BYTES,
	512 * 1024,
);
const APP_HTML_CHUNK_BYTES = positiveInt(
	process.env.BENCH_APP_HTML_CHUNK_BYTES,
	4096,
);
const STRUCTURED_JSON_NOISE_BYTES = positiveInt(
	process.env.BENCH_STRUCTURED_JSON_NOISE_BYTES,
	16 * 1024,
);
const STREAM_CUMULATIVE_STEPS = positiveInt(
	process.env.BENCH_STREAM_CUMULATIVE_STEPS,
	160,
);
const STREAM_CUMULATIVE_STEP_CHARS = positiveInt(
	process.env.BENCH_STREAM_CUMULATIVE_STEP_CHARS,
	256,
);
const STREAM_LONG_LINE_BYTES = positiveInt(
	process.env.BENCH_STREAM_LONG_LINE_BYTES,
	64 * 1024,
);
const STREAM_LONG_LINE_CHUNK_BYTES = positiveInt(
	process.env.BENCH_STREAM_LONG_LINE_CHUNK_BYTES,
	128,
);
const SOCKET_LONG_CHUNK_LINE_BYTES = positiveInt(
	process.env.BENCH_SOCKET_LONG_CHUNK_LINE_BYTES,
	4096,
);
const CONFIG_CACHE_BENCH_ENVS = {
	empty: {},
	realistic: {
		API_KEYS: ["sk-bench-primary", "sk-bench-secondary"],
		ADMIN_KEY: "admin-bench-secret",
		DEFAULT_MODEL: "gemini-3.5-flash",
	},
	large: {
		API_KEYS: ["a".repeat(4096), "b".repeat(4096)],
		ADMIN_KEY: "c".repeat(4096),
	},
	maximum: {
		API_KEYS: Array.from(
			{ length: 50 },
			(_, index) => `${String(index).padStart(2, "0")}-${"k".repeat(4093)}`,
		),
		ADMIN_KEY: "a".repeat(4096),
	},
};
const ATTACHMENT_DEDUPE_BYTES = new Uint8Array(8 * 1024 * 1024);
ATTACHMENT_DEDUPE_BYTES.fill(0x61);
const ATTACHMENT_DEDUPE_INPUT = {
	candidate: {},
	bytes: ATTACHMENT_DEDUPE_BYTES,
	mime: "application/octet-stream",
	filename: "benchmark.bin",
};
const TOOL = {
	type: "function",
	function: {
		name: "Read",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
};
const CFG = {
	gemini_bl: "bench",
	gemini_origin: "https://gemini.google.com",
	upstream_socket: false,
	default_model: "gemini-3.5-flash",
	retry_attempts: 1,
	retry_delay_sec: 0,
	request_timeout_sec: 1,
	log_requests: false,
	current_input_file_enabled: true,
	current_input_file_min_bytes: 95000,
	current_input_file_name: "message.txt",
	current_tools_file_name: "tools.txt",
	api_keys: [],
	cookie: "",
	sapisid: "",
};
const FAKE_PROVIDER = {
	async generateText() {
		return "ok";
	},
	async *streamText() {
		yield "ok";
	},
	async resolveAttachments() {
		return emptyAttachmentResult();
	},
	async uploadTextFile(_text, filename) {
		return { ref: `/uploaded/${filename}`, name: filename };
	},
};

const longFalsePositive = makeLongFalsePositiveText(96_000);
const validDsml = [
	"before",
	'<tool_calls><invoke name="Read"><parameter name="path">/tmp/a.txt</parameter></invoke></tool_calls>',
	"after",
].join("\n");
const messages = [
	{ role: "system", content: "You are concise." },
	{ role: "user", content: "Read the file and summarize it." },
];
const tools = [TOOL];
const toolBundle = mod.createToolBundle(tools);
const socketSingleBody = makeBytes(SOCKET_BODY_BYTES);
const socketChunks = makeSocketChunks(SOCKET_BODY_BYTES, SOCKET_CHUNK_BYTES);
const socketTextSingleResponse = makeHttpResponseChunks(
	socketSingleBody,
	SOCKET_BODY_BYTES,
);
const socketTextMultiResponse = makeHttpResponseChunks(
	socketChunks,
	SOCKET_BODY_BYTES,
);
const uniqueItemsValue = makeUniqueCompositeValues(UNIQUE_ITEMS_COUNT);
const uniqueItemsRequirement = {
	type: "json_schema",
	schema: { type: "array", uniqueItems: true },
};
const structuredPatternValue = {
	tag: "ok-ready",
	slug: "item-123",
	note: "alpha",
};
const structuredPatternRequirement = {
	type: "json_schema",
	schema: {
		type: "object",
		required: ["tag", "slug"],
		properties: {
			tag: { type: "string", pattern: "^ok-[a-z0-9-]{2,32}$" },
			slug: { type: "string", pattern: "^[a-z]+-[0-9]{3}$" },
			note: { type: "string", pattern: "^[a-z]+$" },
		},
	},
};
const base64Input = bytesToBase64(makeBytes(BASE64_BYTES));
const multipartBytes = makeBytes(MULTIPART_BYTES);
const appPageTokensHtml = makeAppHtml(
	APP_HTML_BYTES,
	'{"qKIAYe":"push-bench","SNlM0e":"at-bench"}',
);
const appBuildLabelHtml = makeAppHtml(
	APP_HTML_BYTES,
	'<script>{"cfb2h":"bench-bl"}</script>',
);
const structuredJsonNoise = "{".repeat(STRUCTURED_JSON_NOISE_BYTES);
const markdownRestoreMasked = mod.maskMarkdownProtectedSpans(
	makeMarkdownProtectedText(300),
);
const markdownRestorePlaceholderCount = countOccurrences(
	markdownRestoreMasked.text,
	"GEMINI_MD_PROTECTED_",
);
const largeJsonBody = JSON.stringify({
	message: "x".repeat(128 * 1024),
	ok: true,
});
const longHeldToolCandidate = makeLongHeldToolCandidate(240 * 1024);
const cumulativeWrbLines = makeCumulativeWrbLines(
	STREAM_CUMULATIVE_STEPS,
	STREAM_CUMULATIVE_STEP_CHARS,
);
const longLineResponseChunks = makeLongLineStreamResponseChunks(
	STREAM_LONG_LINE_BYTES,
	STREAM_LONG_LINE_CHUNK_BYTES,
);
const socketLongChunkedLineResponse = makeSocketLongChunkedLineResponse(
	SOCKET_LONG_CHUNK_LINE_BYTES,
);
const smallDeltaProvider = {
	async generateText() {
		return "ok";
	},
	async *streamText() {
		for (let i = 0; i < SSE_CHUNKS; i++) yield "x";
	},
	async resolveAttachments() {
		return emptyAttachmentResult();
	},
	async uploadTextFile(_text, filename) {
		return { ref: `/uploaded/${filename}`, name: filename };
	},
};
const ACCOUNT_ADMIN_BENCH_COUNT = positiveInt(
	process.env.BENCH_ACCOUNT_ADMIN_COUNT,
	1000,
);
const accountAdminIds = Array.from(
	{ length: ACCOUNT_ADMIN_BENCH_COUNT },
	(_value, index) => `bench-account-${index}`,
);
const accountAdminItems = accountAdminIds.map((id) => ({
	id,
	label: null,
	enabled: true,
	state: "available",
	issue: null,
	cooldown_until_ms: null,
	last_issue_at_ms: null,
	last_used_at_ms: null,
	last_refresh_at_ms: null,
	created_at_ms: 1,
	updated_at_ms: 1,
}));
const accountAdminBulkIds = accountAdminIds.slice(0, 100);
const accountAdminStats = {
	total: accountAdminItems.length,
	available: accountAdminItems.length,
	cooling: 0,
	attention: 0,
	disabled: 0,
};
const accountAdminStore = {
	async getAdminOverview(_filter, _nowMs) {
		return {
			items: accountAdminItems.slice(0, 200).map((item) => ({ ...item })),
			nextCursor: null,
			limit: 200,
			stats: accountAdminStats,
		};
	},
	async updateAccount(id, update) {
		const item =
			accountAdminItems[Number(id.slice(id.lastIndexOf("-") + 1))] || null;
		if (!item) return { item: null, changed: false };
		const enabled = update.enabled ?? item.enabled;
		const label = update.label === undefined ? item.label : update.label;
		return {
			item: { ...item, enabled, label, updated_at_ms: update.nowMs },
			changed: enabled !== item.enabled || label !== item.label,
		};
	},
	async getPoolVersion() {
		return "1";
	},
	async listSelectableAccounts() {
		return [];
	},
};
const accountAdminService = new mod.GeminiAccountAdminService({
	adminStore: accountAdminStore,
	runtimeStore: accountAdminStore,
	cfg: { ...CFG, runtime_profile: "worker" },
	nowMs: () => 1,
});

function emptyAttachmentResult() {
	return {
		fileRefs: null,
		imageFileRefs: null,
		genericFileRefs: null,
		droppedNote: "",
		usage: {
			uploadedFiles: 0,
			dedupedFiles: 0,
			uploadedBytes: 0,
			droppedFiles: 0,
		},
	};
}

const cases = [
	{
		name: "config_cache_empty",
		fn: () => mod.getConfig(CONFIG_CACHE_BENCH_ENVS.empty),
	},
	{
		name: "config_cache_realistic",
		fn: () => mod.getConfig(CONFIG_CACHE_BENCH_ENVS.realistic),
	},
	{
		name: "config_cache_large_secrets",
		fn: () => mod.getConfig(CONFIG_CACHE_BENCH_ENVS.large),
		iterations: Math.min(ITERATIONS, 1000),
		warmup: Math.min(WARMUP, 100),
	},
	{
		name: "config_cache_maximum_secrets",
		fn: () => mod.getConfig(CONFIG_CACHE_BENCH_ENVS.maximum),
		iterations: Math.min(ITERATIONS, 200),
		warmup: Math.min(WARMUP, 20),
	},
	{
		name: "attachment_dedupe_large",
		fn: () => mod.attachmentDedupeKeyForTest(ATTACHMENT_DEDUPE_INPUT),
		iterations: Math.min(ITERATIONS, 30),
		warmup: Math.min(WARMUP, 5),
	},
	{
		name: "route_options",
		fn: () =>
			mod.default.fetch(
				new Request("https://worker.example/v1/models", { method: "OPTIONS" }),
				{},
				{},
			),
	},
	{
		name: "route_health",
		fn: () => mod.default.fetch(new Request("https://worker.example/"), {}, {}),
	},
	{
		name: "route_models",
		fn: () =>
			mod.default.fetch(
				new Request("https://worker.example/v1/models"),
				{},
				{},
			),
	},
	{
		name: "json_invalid",
		fn: () =>
			mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					body: "{",
				}),
				{},
				{},
			),
	},
	{
		name: "json_large_strict",
		fn: () => runReadLargeJsonStrict(),
		iterations: Math.min(ITERATIONS, 500),
		warmup: Math.min(WARMUP, 100),
	},
	{
		name: "json_oversized_reject",
		fn: () =>
			mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: { "content-length": "95001" },
					body: "{}",
				}),
				{},
				{},
			),
	},
	{
		name: "messages_to_prompt",
		fn: () =>
			mod.messagesToPrompt(
				messages,
				toolBundle,
				"auto",
				toolBundle.defs,
				"",
				1_000_000,
			),
	},
	{
		name: "prepare_openai_context",
		fn: () =>
			mod.prepareOpenAIGeminiContext(
				CFG,
				FAKE_PROVIDER,
				{ model: "gemini-3.5-flash" },
				messages,
				toolBundle,
				"auto",
				null,
				null,
			),
	},
	{
		name: "parse_plain_long_false_positive",
		fn: () => mod.parseToolCalls(longFalsePositive, tools),
	},
	{ name: "parse_valid_dsml", fn: () => mod.parseToolCalls(validDsml, tools) },
	{
		name: "stream_sieve_plain_chunks",
		fn: () => runPlainSieveChunks(longFalsePositive),
	},
	{
		name: "stream_sieve_held_tool",
		fn: () => runHeldToolCandidateChunks(longHeldToolCandidate),
		iterations: Math.min(ITERATIONS, 300),
		warmup: Math.min(WARMUP, 50),
	},
	{
		name: "stream_text_cumulative_deltas",
		fn: () => runStreamTextCumulativeDeltas(),
		iterations: Math.min(ITERATIONS, 120),
		warmup: Math.min(WARMUP, 20),
	},
	{
		name: "gemini_stream_long_line_chunks",
		fn: () => runGeminiStreamLongLineChunks(),
		iterations: Math.min(ITERATIONS, 80),
		warmup: Math.min(WARMUP, 10),
	},
	{
		name: "responses_small_delta_stream",
		fn: () => runResponsesSmallDeltaStream(),
		iterations: Math.min(ITERATIONS, 60),
		warmup: Math.min(WARMUP, 10),
	},
	{
		name: "google_small_delta_stream",
		fn: () => runGoogleSmallDeltaStream(),
		iterations: Math.min(ITERATIONS, 60),
		warmup: Math.min(WARMUP, 10),
	},
	{
		name: "sse_many_small_delta",
		fn: () => runSseChunks({ chunks: SSE_CHUNKS, delayMs: 0 }),
		iterations: Math.min(ITERATIONS, 400),
		warmup: Math.min(WARMUP, 100),
	},
	{
		name: "sse_slow_consumer",
		fn: () =>
			runSseChunks({ chunks: SSE_SLOW_CHUNKS, delayMs: SSE_SLOW_DELAY_MS }),
		iterations: Math.min(ITERATIONS, 30),
		warmup: Math.min(WARMUP, 5),
	},
	{
		name: "socket_single_chunk_body",
		fn: () => runSocketSingleChunkBody(),
		iterations: Math.min(ITERATIONS, 1000),
		warmup: Math.min(WARMUP, 200),
	},
	{
		name: "socket_multi_chunk_body",
		fn: () => runSocketMultiChunkBody(),
		iterations: Math.min(ITERATIONS, 1000),
		warmup: Math.min(WARMUP, 200),
	},
	{
		name: "socket_text_single_chunk",
		fn: () => runSocketText(socketTextSingleResponse),
		iterations: Math.min(ITERATIONS, 400),
		warmup: Math.min(WARMUP, 100),
	},
	{
		name: "socket_text_multi_chunk",
		fn: () => runSocketText(socketTextMultiResponse),
		iterations: Math.min(ITERATIONS, 400),
		warmup: Math.min(WARMUP, 100),
	},
	{
		name: "socket_chunked_long_split_line",
		fn: () => runSocketText(socketLongChunkedLineResponse),
		iterations: Math.min(ITERATIONS, 80),
		warmup: Math.min(WARMUP, 10),
	},
	{
		name: "structured_unique_items",
		fn: () => runUniqueItemsValidation(),
		iterations: Math.min(ITERATIONS, 200),
		warmup: Math.min(WARMUP, 50),
	},
	{
		name: "account_admin_overview",
		fn: () => accountAdminService.overview({ limit: 200 }),
	},
	{
		name: "account_admin_bulk_action",
		fn: () =>
			accountAdminService.runBulkAction({
				action: "disable",
				ids: accountAdminBulkIds,
			}),
	},
	{
		name: "structured_pattern_schema",
		fn: () => runStructuredPatternValidation(),
		iterations: Math.min(ITERATIONS, 1000),
		warmup: Math.min(WARMUP, 200),
	},
	{
		name: "base64_decode_large",
		fn: () => runBase64Decode(),
		iterations: Math.min(ITERATIONS, 1000),
		warmup: Math.min(WARMUP, 200),
	},
	{
		name: "multipart_body_large",
		fn: () => runMultipartBodyLarge(),
		iterations: Math.min(ITERATIONS, 1000),
		warmup: Math.min(WARMUP, 200),
	},
	{
		name: "app_page_tokens_large",
		fn: () => runAppPageTokensLarge(),
		iterations: Math.min(ITERATIONS, 200),
		warmup: Math.min(WARMUP, 50),
	},
	{
		name: "app_build_label_large",
		fn: () => runAppBuildLabelLarge(),
		iterations: Math.min(ITERATIONS, 200),
		warmup: Math.min(WARMUP, 50),
	},
	{
		name: "structured_json_unclosed",
		fn: () => runStructuredJsonUnclosed(),
		iterations: Math.min(ITERATIONS, 100),
		warmup: Math.min(WARMUP, 20),
	},
	{ name: "rand_hex_32", fn: () => runRandHex32() },
	{
		name: "markdown_restore_many",
		fn: () => runMarkdownRestoreMany(),
		iterations: Math.min(ITERATIONS, 1000),
		warmup: Math.min(WARMUP, 200),
	},
];

const caseFilters = String(process.env.BENCH_CASES || "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
const selectedCases = caseFilters.length
	? cases.filter((item) =>
			caseFilters.some((filter) => item.name.includes(filter)),
		)
	: cases;
if (!selectedCases.length) {
	errorLine(`No benchmark cases matched BENCH_CASES=${caseFilters.join(",")}`);
	process.exit(1);
}

const results = [];
for (const item of selectedCases) {
	const result = await bench(item.fn, item);
	results.push({ name: item.name, ...result });
}
if (JSON_OUTPUT) {
	outputLine(
		JSON.stringify({
			iterations: ITERATIONS,
			warmup: WARMUP,
			filters: caseFilters,
			results,
		}),
	);
} else {
	outputLine(`Benchmark iterations=${ITERATIONS} warmup=${WARMUP}`);
	if (caseFilters.length)
		outputLine(`Benchmark filters=${caseFilters.join(",")}`);
	for (const result of results) outputLine(formatResult(result.name, result));
}

async function bench(fn, options = {}) {
	const iterations = positiveInt(options.iterations, ITERATIONS);
	const warmup = positiveInt(options.warmup, WARMUP);
	for (let i = 0; i < warmup; i++) await fn();
	const samples = new Array(iterations);
	let lastValue;
	const totalStart = performance.now();
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		lastValue = await fn();
		samples[i] = performance.now() - start;
	}
	const totalMs = performance.now() - totalStart;
	samples.sort((a, b) => a - b);
	return {
		iterations,
		warmup,
		medianMs: percentile(samples, 0.5),
		p95Ms: percentile(samples, 0.95),
		p99Ms: percentile(samples, 0.99),
		meanMs: totalMs / iterations,
		opsPerSec: iterations / (totalMs / 1000),
		details: benchmarkDetails(lastValue),
	};
}

function formatResult(name, result) {
	const fields = [
		name.padEnd(30),
		`n=${result.iterations}`,
		`median=${formatMs(result.medianMs)}`,
		`p95=${formatMs(result.p95Ms)}`,
		`p99=${formatMs(result.p99Ms)}`,
		`mean=${formatMs(result.meanMs)}`,
		`ops/s=${Math.round(result.opsPerSec)}`,
	];
	const details = formatDetails(result.details);
	if (details) fields.push(details);
	return fields.join("  ");
}

function benchmarkDetails(value) {
	if (!value || typeof value !== "object" || !value.__benchDetails) return null;
	return value.__benchDetails;
}

function formatDetails(details) {
	if (!details || typeof details !== "object") return "";
	return Object.entries(details)
		.map(
			([key, val]) =>
				`${key}=${typeof val === "number" ? Math.round(val) : String(val)}`,
		)
		.join(" ");
}

function percentile(sorted, p) {
	if (!sorted.length) return 0;
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.floor((sorted.length - 1) * p)),
	);
	return sorted[index] || 0;
}

function formatMs(ms) {
	if (ms < 1) return `${(ms * 1000).toFixed(1)}us`;
	return `${ms.toFixed(3)}ms`;
}

function positiveInt(value, fallback) {
	const n = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function makeLongFalsePositiveText(bytes) {
	const line =
		"ordinary prose: a < b, parameterless discussion, invoke is just a word, tool_calls appears as text.\n";
	let out = "";
	while (out.length < bytes) out += line;
	return out.slice(0, bytes);
}

function makeLongHeldToolCandidate(bytes) {
	const prefix = '<tool_calls><invoke name="Read"><parameter name="path">';
	const suffix = "</parameter></invoke></tool_calls>";
	return (
		prefix +
		"x".repeat(Math.max(0, bytes - prefix.length - suffix.length)) +
		suffix
	);
}

function wrbLine(texts) {
	const inner = [null, null, null, null, [[null, texts]], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

function makeCumulativeWrbLines(steps, stepChars) {
	const lines = [];
	let text = "";
	const piece = "x".repeat(stepChars);
	for (let i = 0; i < steps; i++) {
		text += piece;
		lines.push(wrbLine([text]));
	}
	return lines;
}

function runStreamTextCumulativeDeltas() {
	const extractor = mod.createStreamTextExtractor();
	let deltas = 0;
	let chars = 0;
	for (const line of cumulativeWrbLines) {
		for (const delta of extractor.consumeLine(line)) {
			deltas += 1;
			chars += delta.length;
		}
	}
	return {
		__benchDetails: {
			lines: cumulativeWrbLines.length,
			chars,
			deltas,
		},
	};
}

async function runGeminiStreamLongLineChunks() {
	const stats = installFetchChunks(longLineResponseChunks);
	let chunks = 0;
	let chars = 0;
	try {
		for await (const delta of mod.generateStream(
			CFG,
			"bench",
			1,
			0,
			null,
			null,
		)) {
			chunks += 1;
			chars += delta.length;
		}
	} finally {
		stats.restore();
	}
	return {
		__benchDetails: {
			responseChunks: stats.chunks,
			chars,
			chunks,
		},
	};
}

function makeLongLineStreamResponseChunks(totalBytes, chunkBytes) {
	const text = "x".repeat(totalBytes);
	const line = new TextEncoder().encode(`${wrbLine([text])}\n`);
	const chunks = [];
	for (let i = 0; i < line.length; i += chunkBytes) {
		chunks.push(line.subarray(i, i + chunkBytes));
	}
	return chunks;
}

async function runReadLargeJsonStrict() {
	const parsed = await mod.readJsonRequest(
		new Request("https://worker.example/", {
			method: "POST",
			headers: { "content-length": String(largeJsonBody.length) },
			body: largeJsonBody,
		}),
	);
	return {
		__benchDetails: {
			bytes: parsed.bytes || 0,
			ok: parsed.value?.ok ? 1 : 0,
		},
	};
}

function runPlainSieveChunks(text) {
	const state = mod.createToolSieveState();
	for (let i = 0; i < text.length; i += 1024) {
		mod.processToolSieveChunk(state, text.slice(i, i + 1024));
	}
	return mod.flushToolSieve(state, tools);
}

function runHeldToolCandidateChunks(text) {
	const state = mod.createToolSieveState();
	for (let i = 0; i < text.length; i += 1024) {
		mod.processToolSieveChunk(state, text.slice(i, i + 1024));
	}
	return mod.flushToolSieve(state, tools);
}

async function runResponsesSmallDeltaStream() {
	let writes = 0;
	await mod.streamResponsesWithToolSieve(
		() => {
			writes += 1;
		},
		CFG,
		{
			provider: smallDeltaProvider,
			rid: "resp_bench",
			rm: { name: "gemini-3.5-flash" },
			prompt: "bench",
			fileRefs: null,
			tools: null,
			toolPolicy: null,
			promptTokens: 1,
			signal: new AbortController().signal,
		},
	);
	return {
		__benchDetails: {
			inputDeltas: SSE_CHUNKS,
			writes,
		},
	};
}

async function runGoogleSmallDeltaStream() {
	let writes = 0;
	await mod.streamGooglePlain(
		() => {
			writes += 1;
		},
		CFG,
		{
			provider: smallDeltaProvider,
			prompt: "bench",
			rm: { name: "gemini-3.5-flash" },
			fileRefs: null,
			promptTokens: 1,
			signal: new AbortController().signal,
		},
	);
	return {
		__benchDetails: {
			inputDeltas: SSE_CHUNKS,
			writes,
		},
	};
}

async function runSseChunks({ chunks, delayMs }) {
	const frame = "data: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n\n";
	let producedBytes = 0;
	let consumedBytes = 0;
	let peakBufferedBytes = 0;
	const resp = mod.sseResponse(async (write) => {
		for (let i = 0; i < chunks; i++) {
			producedBytes += frame.length;
			peakBufferedBytes = Math.max(
				peakBufferedBytes,
				producedBytes - consumedBytes,
			);
			await write(frame);
			peakBufferedBytes = Math.max(
				peakBufferedBytes,
				producedBytes - consumedBytes,
			);
		}
	});
	const reader = resp.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		consumedBytes += value ? value.length : 0;
		peakBufferedBytes = Math.max(
			peakBufferedBytes,
			producedBytes - consumedBytes,
		);
		if (delayMs > 0) await delay(delayMs);
	}
	return {
		__benchDetails: {
			totalBytes: producedBytes,
			peakBufferedBytes,
		},
	};
}

function delay(ms) {
	return new Promise((done) => setTimeout(done, ms));
}

function runSocketSingleChunkBody() {
	const queue = mod.createByteQueue(socketSingleBody);
	const out = queue.read(socketSingleBody.length);
	return {
		__benchDetails: {
			totalBytes: out.length,
			sameBuffer:
				out.buffer === socketSingleBody.buffer &&
				out.byteOffset === socketSingleBody.byteOffset
					? 1
					: 0,
		},
	};
}

function runSocketMultiChunkBody() {
	const queue = mod.createByteQueue();
	for (const chunk of socketChunks) queue.push(chunk);
	const out = queue.read(SOCKET_BODY_BYTES);
	return {
		__benchDetails: {
			totalBytes: out.length,
			sameBuffer: socketChunks.some((chunk) => out.buffer === chunk.buffer)
				? 1
				: 0,
		},
	};
}

function makeBytes(length) {
	const out = new Uint8Array(length);
	for (let i = 0; i < out.length; i++) out[i] = i & 255;
	return out;
}

function bytesToBase64(bytes) {
	const native = bytes.toBase64;
	if (typeof native === "function") return native.call(bytes);
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function makeSocketChunks(totalBytes, chunkBytes) {
	const chunks = [];
	let remaining = totalBytes;
	let seed = 0;
	while (remaining > 0) {
		const size = Math.min(chunkBytes, remaining);
		const chunk = new Uint8Array(size);
		for (let i = 0; i < chunk.length; i++) chunk[i] = (seed + i) & 255;
		chunks.push(chunk);
		seed += size;
		remaining -= size;
	}
	return chunks;
}

async function runSocketText(responseChunks) {
	const resp = await mod.socketHttp(
		fakeSocketConnect(responseChunks),
		"https://example.test/text",
		{ timeoutMs: 0 },
	);
	const text = await resp.text();
	return {
		__benchDetails: {
			totalChars: text.length,
			chunks: responseChunks.length,
		},
	};
}

function makeHttpResponseChunks(bodyOrChunks, totalBytes) {
	const head = new TextEncoder().encode(
		`HTTP/1.1 200 OK\r\nContent-Length: ${totalBytes}\r\n\r\n`,
	);
	if (bodyOrChunks instanceof Uint8Array)
		return [concatBytes(head, bodyOrChunks)];
	return [head, ...bodyOrChunks];
}

function makeSocketLongChunkedLineResponse(lineBytes) {
	const encoder = new TextEncoder();
	const head = encoder.encode(
		"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
	);
	const line = encoder.encode(`1;${"x".repeat(lineBytes)}\r\n`);
	const tail = encoder.encode("a\r\n0\r\n\r\n");
	const chunks = [head];
	for (let i = 0; i < line.length; i++) chunks.push(line.subarray(i, i + 1));
	chunks.push(tail);
	return chunks;
}

function fakeSocketConnect(responseChunks) {
	return () => ({
		readable: new ReadableStream({
			start(controller) {
				for (const chunk of responseChunks) controller.enqueue(chunk);
				controller.close();
			},
		}),
		writable: new WritableStream({
			write() {},
		}),
		close() {},
	});
}

function concatBytes(a, b) {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function runUniqueItemsValidation() {
	const error = mod.validateStructuredOutputValue(
		uniqueItemsValue,
		uniqueItemsRequirement,
	);
	return {
		__benchDetails: {
			items: uniqueItemsValue.length,
			ok: error ? 0 : 1,
		},
	};
}

function runStructuredPatternValidation() {
	let error = "";
	for (let i = 0; i < 100; i++) {
		error = mod.validateStructuredOutputValue(
			structuredPatternValue,
			structuredPatternRequirement,
		);
	}
	return {
		__benchDetails: {
			checks: 100,
			ok: error ? 0 : 1,
		},
	};
}

function makeUniqueCompositeValues(count) {
	const out = [];
	for (let i = 0; i < count; i++) {
		out.push({
			id: i,
			tags: [`tag-${i % 17}`, `group-${Math.floor(i / 17)}`],
			nested: {
				left: { value: i * 3, ok: (i & 1) === 0 },
				right: [i, { label: `item-${i}` }],
			},
		});
	}
	return out;
}

function runBase64Decode() {
	const bytes = mod.base64ToBytes(base64Input);
	return {
		__benchDetails: {
			bytes: bytes.length,
		},
	};
}

function runMultipartBodyLarge() {
	const multipart = mod.buildMultipartFileBody({
		bytes: multipartBytes,
		mime: "application/octet-stream",
		filename: "large.bin",
	});
	return {
		__benchDetails: {
			bytes: multipart.contentLength,
		},
	};
}

async function runAppPageTokensLarge() {
	mod.resetGeminiUploadCachesForTest();
	const stats = installFetchResponse(appPageTokensHtml);
	try {
		const tokens = await mod.getPageTokens(CFG);
		return {
			__benchDetails: {
				htmlBytes: stats.bytes,
				pulls: stats.pulls,
				canceled: stats.canceled,
				ok: tokens.push_id === "push-bench" && tokens.at === "at-bench" ? 1 : 0,
			},
		};
	} finally {
		stats.restore();
	}
}

async function runAppBuildLabelLarge() {
	const stats = installFetchResponse(appBuildLabelHtml);
	try {
		const label = await mod.getFreshGeminiBuildLabel(CFG);
		return {
			__benchDetails: {
				htmlBytes: stats.bytes,
				pulls: stats.pulls,
				canceled: stats.canceled,
				ok: label === "bench-bl" ? 1 : 0,
			},
		};
	} finally {
		stats.restore();
	}
}

function makeAppHtml(totalBytes, tokenBlock) {
	const prefix = `<!doctype html><html><head>${tokenBlock}</head><body>`;
	const suffix = "</body></html>";
	const fillerUnit =
		"app bootstrap payload: boq_assistant placeholder config data;\n";
	let filler = "";
	const target = Math.max(0, totalBytes - prefix.length - suffix.length);
	while (filler.length < target) filler += fillerUnit;
	return prefix + filler.slice(0, target) + suffix;
}

function installFetchResponse(text) {
	const originalFetch = globalThis.fetch;
	const encoded = new TextEncoder().encode(text);
	const stats = {
		bytes: encoded.length,
		pulls: 0,
		canceled: 0,
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream({
				pull(controller) {
					const start = stats.pulls * APP_HTML_CHUNK_BYTES;
					if (start >= encoded.length) {
						controller.close();
						return;
					}
					stats.pulls += 1;
					controller.enqueue(
						encoded.subarray(start, start + APP_HTML_CHUNK_BYTES),
					);
				},
				cancel() {
					stats.canceled += 1;
				},
			}),
		);
	return stats;
}

function installFetchChunks(chunks) {
	const originalFetch = globalThis.fetch;
	const stats = {
		chunks: chunks.length,
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			}),
			{ status: 200 },
		);
	return stats;
}

function runStructuredJsonUnclosed() {
	const candidate = mod.extractFirstJsonDocument(structuredJsonNoise);
	return {
		__benchDetails: {
			bytes: structuredJsonNoise.length,
			found: candidate ? 1 : 0,
		},
	};
}

function runRandHex32() {
	const value = mod.randHex(32);
	return {
		__benchDetails: {
			chars: value.length,
		},
	};
}

function runMarkdownRestoreMany() {
	const restored = markdownRestoreMasked.restore(markdownRestoreMasked.text);
	return {
		__benchDetails: {
			chars: restored.length,
			placeholders: markdownRestorePlaceholderCount,
		},
	};
}

function makeMarkdownProtectedText(count) {
	const parts = [];
	for (let i = 0; i < count; i++) {
		parts.push(`plain ${i} \`<tool_calls>${i}</tool_calls>\` tail`);
	}
	return parts.join("\n");
}

function countOccurrences(text, needle) {
	let count = 0;
	let index = String(text || "").indexOf(needle);
	while (index >= 0) {
		count += 1;
		index = String(text || "").indexOf(needle, index + needle.length);
	}
	return count;
}
