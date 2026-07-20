import type {
	FilePart,
	ImagePart,
	InternalMessage,
	TextPart,
} from "../../../../src/promptcompat/message-model";
export function messageAt(
	messages: readonly InternalMessage[],
	index: number,
): InternalMessage {
	const message = messages[index];
	if (!message) throw new TypeError(`expected message at index ${index}`);
	return message;
}
export function textPartAt(message: InternalMessage, index: number): TextPart {
	const part = message.parts[index];
	if (part?.kind !== "text")
		throw new TypeError(`expected text part at index ${index}`);
	return part;
}
export function imagePartAt(
	message: InternalMessage,
	index: number,
): ImagePart {
	const part = message.parts[index];
	if (part?.kind !== "image")
		throw new TypeError(`expected image part at index ${index}`);
	return part;
}
export function filePartAt(message: InternalMessage, index: number): FilePart {
	const part = message.parts[index];
	if (part?.kind !== "file")
		throw new TypeError(`expected file part at index ${index}`);
	return part;
}
