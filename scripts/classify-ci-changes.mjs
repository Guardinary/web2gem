import { appendFile } from "node:fs/promises";
import { classifyChangedFiles } from "./ci-change-risk.mjs";
import { outputLine } from "./io.mjs";

const files = process.env.CI_CHANGED_FILES_JSON
	? JSON.parse(process.env.CI_CHANGED_FILES_JSON)
	: await readNullSeparatedStdin();
const risk = classifyChangedFiles(Array.isArray(files) ? files : []);
outputLine(risk);
if (process.env.GITHUB_OUTPUT)
	await appendFile(
		process.env.GITHUB_OUTPUT,
		`risk=${risk}\nruntime=${risk === "runtime"}\n`,
	);

async function readNullSeparatedStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8").split("\0");
}
