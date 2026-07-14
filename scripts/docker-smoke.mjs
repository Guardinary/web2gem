import { outputLine } from "./io.mjs";
import { commandAvailable, outputCommand, runCommand } from "./process.mjs";

if (!(await commandAvailable("docker"))) {
	outputLine("Docker smoke skipped: docker executable not found");
	process.exit(0);
}

const image = `web2gem:smoke-${process.pid}`;
let container = "";

try {
	await runCommand("docker", ["build", "-t", image, "."]);
	container = (
		await outputCommand("docker", [
			"run",
			"-d",
			"--rm",
			"-p",
			"127.0.0.1::52389",
			"-e",
			"API_KEYS=smoke-key",
			"-e",
			"CURRENT_INPUT_FILE_ENABLED=false",
			image,
		])
	).trim();

	const port = await mappedPort(container);
	const base = `http://127.0.0.1:${port}`;
	await waitForHealth(base);

	const health = await fetch(`${base}/`);
	assert(health.status === 200, `health status ${health.status}`);
	const healthBody = await health.json();
	assert(healthBody.status === "ok", "health payload did not report ok");

	const authFailure = await fetch(`${base}/v1/models`);
	assert(
		authFailure.status === 401,
		`auth failure status ${authFailure.status}`,
	);

	const models = await fetch(`${base}/v1/models`, {
		headers: { Authorization: "Bearer smoke-key" },
	});
	assert(models.status === 200, `authenticated models status ${models.status}`);

	const missingD1 = await fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: "Bearer smoke-key",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "gemini-3.1-pro",
			messages: [{ role: "user", content: "hello" }],
		}),
	});
	assert(missingD1.status === 422, `missing D1 status ${missingD1.status}`);
	const missingD1Body = await missingD1.json();
	assert(
		missingD1Body.error?.code === "gemini_authenticated_session_required" &&
			missingD1Body.error?.reason === "pro_model",
		"missing D1 did not return the authenticated-session error",
	);

	outputLine("Docker smoke check passed");
} finally {
	if (container) {
		await outputCommand("docker", ["stop", container], { allowFailure: true });
	}
	await outputCommand("docker", ["rmi", image], { allowFailure: true });
}

async function mappedPort(containerId) {
	for (let i = 0; i < 30; i++) {
		const raw = (
			await outputCommand("docker", ["port", containerId, "52389/tcp"], {
				allowFailure: true,
			})
		).trim();
		const match = /:(\d+)\s*$/.exec(raw);
		if (match) return Number(match[1]);
		await delay(250);
	}
	throw new Error("Docker smoke failed: container port was not mapped");
}

async function waitForHealth(base) {
	let lastError = null;
	for (let i = 0; i < 60; i++) {
		try {
			const resp = await fetch(`${base}/`);
			if (resp.status === 200) return;
			lastError = new Error(`health status ${resp.status}`);
		} catch (err) {
			lastError = err;
		}
		await delay(250);
	}
	throw new Error(
		`Docker smoke failed: health route did not become ready: ${lastError}`,
	);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(ok, message) {
	if (!ok) throw new Error(`Docker smoke failed: ${message}`);
}
