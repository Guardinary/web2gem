const REQUIRED_D1_HTTP_ENV = [
	"D1_ACCOUNT_ID",
	"D1_DATABASE_ID",
	"D1_API_TOKEN",
];

export function resolveD1HttpConfig(env = process.env) {
	const values = {
		accountId: clean(env.D1_ACCOUNT_ID),
		databaseId: clean(env.D1_DATABASE_ID),
		apiToken: clean(env.D1_API_TOKEN),
	};
	const present = [values.accountId, values.databaseId, values.apiToken].filter(
		Boolean,
	).length;
	if (present === 0) return null;
	if (present !== 3) {
		throw new D1HttpBindingError(
			`partial D1 HTTP configuration: ${REQUIRED_D1_HTTP_ENV.filter((name) => !clean(env[name])).join(", ")} missing`,
			{
				code: "d1_http_partial_config",
			},
		);
	}
	return values;
}

export function createD1HttpBinding(config, options = {}) {
	const fetchImpl = options.fetch || globalThis.fetch;
	if (typeof fetchImpl !== "function") {
		throw new D1HttpBindingError("D1 HTTP binding requires fetch", {
			code: "d1_http_fetch_missing",
		});
	}
	const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/d1/database/${encodeURIComponent(config.databaseId)}/query`;
	const owner = {};
	return {
		prepare(sql) {
			return new D1HttpPreparedStatement({
				endpoint,
				token: config.apiToken,
				sql: String(sql || ""),
				params: [],
				fetchImpl,
				owner,
			});
		},
		async batch(statements) {
			if (!Array.isArray(statements)) {
				throw new D1HttpBindingError("D1 HTTP batch requires statements", {
					code: "d1_http_invalid_batch",
				});
			}
			if (!statements.length) return [];
			const batch = statements.map((statement) => {
				if (!(statement instanceof D1HttpPreparedStatement)) {
					throw new D1HttpBindingError(
						"D1 HTTP batch received an invalid statement",
						{ code: "d1_http_invalid_batch_statement" },
					);
				}
				return statement.batchQuery(owner);
			});
			const payload = await requestD1({
				endpoint,
				token: config.apiToken,
				fetchImpl,
				body: { batch },
			});
			return normalizeD1HttpBatchPayload(payload, batch.length);
		},
	};
}

export function createD1HttpBindingFromEnv(env = process.env, options = {}) {
	const config = resolveD1HttpConfig(env);
	return config ? createD1HttpBinding(config, options) : null;
}

export class D1HttpBindingError extends Error {
	constructor(message, metadata = {}) {
		super(message);
		this.name = "D1HttpBindingError";
		this.code = metadata.code || "d1_http_error";
		if (metadata.status) this.status = metadata.status;
	}
}

class D1HttpPreparedStatement {
	constructor({ endpoint, token, sql, params, fetchImpl, owner }) {
		this.endpoint = endpoint;
		this.token = token;
		this.sql = sql;
		this.params = params;
		this.fetchImpl = fetchImpl;
		this.owner = owner;
	}

	bind(...values) {
		return new D1HttpPreparedStatement({
			endpoint: this.endpoint,
			token: this.token,
			sql: this.sql,
			params: values,
			fetchImpl: this.fetchImpl,
			owner: this.owner,
		});
	}

	batchQuery(owner) {
		if (owner !== this.owner) {
			throw new D1HttpBindingError(
				"D1 HTTP batch statement belongs to another binding",
				{ code: "d1_http_batch_binding_mismatch" },
			);
		}
		return { sql: this.sql, params: this.params };
	}

	async first(columnName) {
		const result = await this.all();
		const row = Array.isArray(result.results)
			? result.results[0] || null
			: null;
		if (!row || columnName === undefined) return row;
		return Object.hasOwn(row, columnName) ? row[columnName] : null;
	}

	async all() {
		return this.query();
	}

	async run() {
		const result = await this.query();
		return { success: result.success, meta: result.meta };
	}

	async query() {
		const payload = await requestD1({
			endpoint: this.endpoint,
			token: this.token,
			fetchImpl: this.fetchImpl,
			body: { sql: this.sql, params: this.params },
		});
		return normalizeD1HttpPayload(payload);
	}
}

async function requestD1({ endpoint, token, fetchImpl, body }) {
	let response;
	try {
		response = await fetchImpl(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	} catch (_) {
		throw new D1HttpBindingError("D1 HTTP query failed before response", {
			code: "d1_http_fetch_error",
			status: 502,
		});
	}
	if (!response?.ok) {
		throw new D1HttpBindingError(
			`D1 HTTP query failed status=${Number(response?.status) || 0}`,
			{
				code: "d1_http_status",
				status: Number(response?.status) || 500,
			},
		);
	}
	let payload;
	try {
		payload = await response.json();
	} catch (_) {
		throw new D1HttpBindingError("D1 HTTP query returned invalid JSON", {
			code: "d1_http_invalid_json",
		});
	}
	if (!payload || payload.success === false) {
		throw new D1HttpBindingError(safeCloudflareErrorMessage(payload), {
			code: "d1_http_api_error",
			status: 502,
		});
	}
	return payload;
}

function normalizeD1HttpPayload(payload) {
	const result = Array.isArray(payload.result)
		? payload.result[0]
		: payload.result;
	if (!result || result.success === false) {
		throw new D1HttpBindingError(safeCloudflareErrorMessage(payload), {
			code: "d1_http_api_error",
			status: 502,
		});
	}
	return normalizeD1HttpResult(result);
}

function normalizeD1HttpBatchPayload(payload, expectedResults) {
	const results = Array.isArray(payload.result) ? payload.result : [];
	if (results.length !== expectedResults) {
		throw new D1HttpBindingError(
			"D1 HTTP batch returned an unexpected result count",
			{ code: "d1_http_invalid_batch_result", status: 502 },
		);
	}
	return results.map((result, index) => {
		if (!result || result.success === false) {
			throw new D1HttpBindingError(
				`D1 HTTP batch query failed index=${index}`,
				{ code: "d1_http_batch_query_error", status: 502 },
			);
		}
		return normalizeD1HttpResult(result);
	});
}

function normalizeD1HttpResult(result) {
	const rows = result?.results;
	const meta = result?.meta || {};
	return {
		results: Array.isArray(rows) ? rows : [],
		success: result?.success !== false,
		meta,
	};
}

function safeCloudflareErrorMessage(payload) {
	const errors = Array.isArray(payload?.errors) ? payload.errors : [];
	const first = errors[0] || {};
	const code = clean(first.code) || "unknown";
	return `D1 HTTP query failed code=${code}`;
}

function clean(value) {
	return String(value || "").trim();
}
