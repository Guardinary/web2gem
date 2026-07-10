export type AttachmentFileRef =
	| string
	| {
			ref?: string;
			fileRef?: string;
			id?: string;
			name?: string;
			filename?: string;
	  };

export type AttachmentKind = "image" | "file";

export type AttachmentRole = "request" | "context";

export type AttachmentSource =
	| { type: "base64"; data: unknown }
	| { type: "bytes"; bytes: Uint8Array };

export type AttachmentCandidate = {
	id: string;
	kind: AttachmentKind;
	role: AttachmentRole;
	source: AttachmentSource;
	filename?: string;
	mime?: string;
};

export type AttachmentDropReason =
	| "invalid_image_input"
	| "invalid_file_input"
	| "invalid_base64"
	| "invalid_remote_url"
	| "file_too_large"
	| "image_too_large"
	| "too_many_files"
	| "upload_failed";

export type AttachmentDrop = {
	kind: AttachmentKind;
	code: AttachmentDropReason;
	message: string;
	filename?: string;
};

export type AttachmentPlan = {
	candidates: AttachmentCandidate[];
	existingFileRefs: AttachmentFileRef[] | null;
	dropped: AttachmentDrop[];
	maxFiles: number;
};

export type AttachmentUsage = {
	uploadedFiles: number;
	dedupedFiles: number;
	uploadedBytes: number;
	fileRefBytes: number;
	inlinedFiles: number;
	inlinedBytes: number;
	droppedFiles: number;
	multipartUploads: number;
};

export type AttachmentUploadResult = {
	fileRefs: AttachmentFileRef[] | null;
	imageFileRefs: AttachmentFileRef[] | null;
	genericFileRefs: AttachmentFileRef[] | null;
	promptText: string;
	droppedNote: string;
	supportsFileRefs: boolean;
	usage: AttachmentUsage;
};
