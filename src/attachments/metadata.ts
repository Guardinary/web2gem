import { isRecord } from "../shared/types";
import { firstNonEmptyString } from "../shared/strings";
import { sanitizeUploadFilename } from "./mime";

export function uploadFilenameFromObject(obj: unknown): string {
	if (!isRecord(obj)) return "";
	const record = obj;
	const source = isRecord(record.source) ? record.source : null;
	const imageUrl = isRecord(record.image_url) ? record.image_url : null;
	const inlineData = isRecord(record.inlineData)
		? record.inlineData
		: isRecord(record.inline_data)
			? record.inline_data
			: null;
	const fileData = isRecord(record.fileData)
		? record.fileData
		: isRecord(record.file_data)
			? record.file_data
			: null;
	const file = isRecord(record.file) ? record.file : null;
	return firstNonEmptyString(
		...[
			record.filename,
			record.fileName,
			record.file_name,
			record.name,
			record.displayName,
			record.display_name,
			source &&
				(source.filename ||
					source.fileName ||
					source.file_name ||
					source.name ||
					source.displayName ||
					source.display_name),
			imageUrl &&
				(imageUrl.filename ||
					imageUrl.fileName ||
					imageUrl.file_name ||
					imageUrl.name ||
					imageUrl.displayName ||
					imageUrl.display_name),
			inlineData &&
				(inlineData.filename ||
					inlineData.fileName ||
					inlineData.file_name ||
					inlineData.name ||
					inlineData.displayName ||
					inlineData.display_name),
			fileData &&
				(fileData.filename ||
					fileData.fileName ||
					fileData.file_name ||
					fileData.name ||
					fileData.displayName ||
					fileData.display_name),
			file &&
				(file.filename ||
					file.fileName ||
					file.file_name ||
					file.name ||
					file.displayName ||
					file.display_name),
		].map(sanitizeUploadFilename),
	);
}
