import { describe, test } from "vitest";
import {
	buildStructuredOutputRequirement,
	canonicalizeStructuredOutputText,
	extractFirstJsonDocument,
	finalizeStructuredOutputText,
	getStructuredResponseFormat,
	parseStructuredJsonCandidate,
	STRUCTURED_JSON_NOT_FOUND,
	validateStructuredOutputValue,
} from "../../../src/completion/structured-output";
import { assert } from "../assertions.js";

describe("structured output", () => {
	test("builds requirements from Chat and Responses format shapes", async () => {
		assert.equal(
			getStructuredResponseFormat({
				text: { format: { type: "json_object" } },
			})?.type,
			"json_object",
		);
		assert.equal(getStructuredResponseFormat(null), null);
		assert.equal(buildStructuredOutputRequirement({}), null);
		assert.equal(
			buildStructuredOutputRequirement({ type: "unsupported" }),
			null,
		);

		const defaulted = buildStructuredOutputRequirement({
			type: "json_schema",
			name: " ",
			schema: { type: "object" },
		});
		if (defaulted?.type !== "json_schema") {
			throw new Error("expected a json_schema requirement");
		}
		assert.match(defaulted.instruction, /Schema name: response/);
		assert.match(defaulted.instruction, /Strict mode: true/);
		const invalid = buildStructuredOutputRequirement({
			type: "json_schema",
			json_schema: { name: "bad" },
		});
		if (!invalid || !("error" in invalid)) {
			throw new Error("expected an invalid schema requirement");
		}
		assert.equal(
			invalid.error,
			"response_format json_schema requires a schema object",
		);

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const unserializable = buildStructuredOutputRequirement({
			type: "json_schema",
			json_schema: { schema: cyclic },
		});
		if (!unserializable || !("error" in unserializable)) {
			throw new Error("expected an unserializable schema requirement");
		}
		assert.equal(
			unserializable.error,
			"response_format json_schema schema must be JSON serializable",
		);
	});

	test("extracts JSON documents from noisy model text", async () => {
		assert.equal(
			extractFirstJsonDocument('prefix [1,{"a":"}"}] suffix'),
			'[1,{"a":"}"}]',
		);
		assert.equal(
			extractFirstJsonDocument('prefix [{"ok":true} } suffix'),
			'{"ok":true}',
		);
		assert.equal(extractFirstJsonDocument('prefix {"a":] suffix'), "");
		assert.equal(extractFirstJsonDocument("{{{{"), "");
		assert.deepEqual(
			parseStructuredJsonCandidate('prefix {"ok":true} suffix'),
			{ ok: true },
		);
		assert.deepEqual(
			parseStructuredJsonCandidate('```json\n{"ok":true}\n```'),
			{
				ok: true,
			},
		);
		assert.equal(
			parseStructuredJsonCandidate("no json here"),
			STRUCTURED_JSON_NOT_FOUND,
		);
	});

	test("canonicalizes and finalizes schema output", async () => {
		const requirement = buildStructuredOutputRequirement({
			type: "json_schema",
			name: "loose_result",
			strict: false,
			schema: { type: "object", properties: { ok: { type: "boolean" } } },
		});
		if (requirement?.type !== "json_schema") {
			throw new Error("expected a json_schema requirement");
		}
		assert.match(requirement.instruction, /Schema name: loose_result/);
		assert.match(requirement.instruction, /Strict mode: false/);
		assert.equal(canonicalizeStructuredOutputText(" raw ", null), " raw ");
		assert.equal(
			canonicalizeStructuredOutputText(
				'prefix {"ok":true} suffix',
				requirement,
			),
			'{"ok":true}',
		);
		assert.deepEqual(
			finalizeStructuredOutputText('prefix {"ok":true} suffix', requirement),
			{ text: '{"ok":true}' },
		);
		assert.match(
			finalizeStructuredOutputText('prefix {"ok":true} suffix', {
				type: "json_schema",
				schema: { allOf: [{ type: "object" }, { required: ["missing"] }] },
			}).error,
			/\.missing is required/,
		);
		assert.equal(
			finalizeStructuredOutputText("not json", requirement).error,
			"structured output was not valid JSON",
		);
	});

	test("validates json_object and delegates representative JSON schemas", async () => {
		assert.equal(validateStructuredOutputValue({}, null), "");
		assert.equal(
			validateStructuredOutputValue("nope", { type: "json_object" }),
			"structured output must be a JSON object",
		);
		assert.equal(
			validateStructuredOutputValue(
				{ ok: true },
				{
					type: "json_schema",
					schema: {
						type: "object",
						required: ["ok"],
						properties: { ok: { type: "boolean" } },
					},
				},
			),
			"",
		);
	});
});
