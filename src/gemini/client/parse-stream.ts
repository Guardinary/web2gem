import { trimContinuationOverlap } from "../../shared/text-metrics";
import { extractTextsFromLine } from "./parse-envelope";
import { hasArtifactMarkers, stripArtifacts } from "./parse-parts";

const STREAM_APPEND_PROBE_CHARS = 64;

export function createStreamTextExtractor() {
	let prevVisibleParts: string[] = [];
	let prevVisibleMaterialized: string | null = "";
	let prevVisibleLength = 0;
	let prevVisibleHead = "";
	let prevVisibleTail = "";
	let prevRaw = "";
	let prevRawLength = 0;
	let prevRawHead = "";
	let prevRawTail = "";
	let prevRawHasArtifacts = false;
	let started = false;
	const rememberRaw = (raw: string) => {
		prevRawLength = raw.length;
		prevRaw = raw.length <= STREAM_APPEND_PROBE_CHARS * 2 ? raw : "";
		prevRawHead = raw.slice(0, STREAM_APPEND_PROBE_CHARS);
		prevRawTail = raw.slice(-STREAM_APPEND_PROBE_CHARS);
		prevRawHasArtifacts = hasArtifactMarkers(raw);
	};
	const rememberVisible = (visible: string) => {
		prevVisibleParts = visible ? [visible] : [];
		prevVisibleMaterialized = visible;
		prevVisibleLength = visible.length;
		prevVisibleHead = visible.slice(0, STREAM_APPEND_PROBE_CHARS);
		prevVisibleTail = visible.slice(-STREAM_APPEND_PROBE_CHARS);
	};
	const materializeVisible = () => {
		if (prevVisibleMaterialized !== null) return prevVisibleMaterialized;
		const visible = prevVisibleParts.join("");
		prevVisibleParts = visible ? [visible] : [];
		prevVisibleMaterialized = visible;
		return visible;
	};
	const appendVisibleDelta = (delta: string) => {
		if (!delta) return;
		const oldLength = prevVisibleLength;
		prevVisibleParts.push(delta);
		prevVisibleMaterialized = null;
		prevVisibleLength += delta.length;
		if (oldLength < STREAM_APPEND_PROBE_CHARS) {
			prevVisibleHead = `${prevVisibleHead}${delta}`.slice(
				0,
				STREAM_APPEND_PROBE_CHARS,
			);
		}
		prevVisibleTail = `${prevVisibleTail}${delta}`.slice(
			-STREAM_APPEND_PROBE_CHARS,
		);
	};
	const rawAppendDelta = (raw: string): string | null => {
		if (!prevRawLength || raw.length <= prevRawLength || prevRawHasArtifacts)
			return null;
		if (prevRawLength <= STREAM_APPEND_PROBE_CHARS * 2) {
			if (!raw.startsWith(prevRaw)) return null;
		} else if (
			raw.slice(0, prevRawHead.length) !== prevRawHead ||
			raw.slice(prevRawLength - prevRawTail.length, prevRawLength) !==
				prevRawTail
		) {
			return null;
		}
		const delta = raw.slice(prevRawLength);
		if (hasArtifactMarkers(prevRawTail + delta)) return null;
		return delta;
	};
	const visibleAppendDelta = (visible: string): string | null => {
		if (!prevVisibleLength || visible.length <= prevVisibleLength) return null;
		if (prevVisibleLength <= STREAM_APPEND_PROBE_CHARS * 2) {
			if (!visible.startsWith(materializeVisible())) return null;
		} else if (
			visible.slice(0, prevVisibleHead.length) !== prevVisibleHead ||
			visible.slice(
				prevVisibleLength - prevVisibleTail.length,
				prevVisibleLength,
			) !== prevVisibleTail
		) {
			return null;
		}
		return visible.slice(prevVisibleLength);
	};
	const consumeLine = function* (line: unknown): Generator<string> {
		for (const t of extractTextsFromLine(line)) {
			const raw = String(t || "");
			let delta = "";
			const appendedRawDelta = rawAppendDelta(raw);
			if (appendedRawDelta !== null) {
				delta = appendedRawDelta;
				appendVisibleDelta(delta);
				rememberRaw(raw);
			} else {
				const visible = stripArtifacts(raw);
				if (!prevVisibleLength) {
					delta = visible;
					rememberVisible(visible);
					rememberRaw(raw);
				} else {
					const appendedVisibleDelta = visibleAppendDelta(visible);
					if (appendedVisibleDelta !== null) {
						delta = appendedVisibleDelta;
						rememberVisible(visible);
						rememberRaw(raw);
					} else if (materializeVisible().startsWith(visible)) {
						continue;
					} else {
						delta = trimContinuationOverlap(materializeVisible(), visible);
						if (!delta) {
							if (visible.length > prevVisibleLength) {
								rememberVisible(visible);
								rememberRaw(raw);
							}
							continue;
						}
						appendVisibleDelta(delta);
						rememberRaw(raw);
					}
				}
			}
			if (!started) delta = delta.replace(/^\s+/, "");
			if (delta) {
				started = true;
				yield delta;
			}
		}
	};
	return { consumeLine };
}
