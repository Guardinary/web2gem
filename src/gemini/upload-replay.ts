import type {
	AttachmentFileRef,
	AttachmentPlan,
	AttachmentUploadResult,
} from "../attachments/types";
import type { CompletionTextInput } from "../completion/ports";
import type { RuntimeConfig } from "../config";
import type { ErrorWithMetadata } from "../shared/types";
import type { resolveAttachments, uploadTextFile } from "./uploads";

export type GeminiUploadDelegates = {
	resolveAttachments: typeof resolveAttachments;
	uploadTextFile: typeof uploadTextFile;
};

type UploadRecipe =
	| {
			kind: "attachments";
			plan: AttachmentPlan;
			currentRefs: AttachmentFileRef[];
	  }
	| {
			kind: "text";
			text: string;
			filename: string;
			currentRef: AttachmentFileRef;
	  };

export class UploadReplayState {
	private queue: Promise<void> = Promise.resolve();
	private readonly recipes: UploadRecipe[] = [];
	private readonly refAliases = new Map<string, AttachmentFileRef>();

	constructor(readonly delegates: GeminiUploadDelegates) {}

	waitForPending(): Promise<void> {
		return this.queue;
	}

	serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	recordAttachments(
		plan: AttachmentPlan,
		result: AttachmentUploadResult,
	): void {
		const currentRefs = [...(result.fileRefs || [])];
		for (const ref of currentRefs) {
			const key = fileRefKey(ref);
			if (key) this.refAliases.set(key, ref);
		}
		this.recipes.push({ kind: "attachments", plan, currentRefs });
	}

	recordText(text: string, filename: string, ref: AttachmentFileRef): void {
		const key = fileRefKey(ref);
		if (key) this.refAliases.set(key, ref);
		this.recipes.push({ kind: "text", text, filename, currentRef: ref });
	}

	async replay(activeCfg: RuntimeConfig): Promise<void> {
		for (const recipe of this.recipes) {
			if (recipe.kind === "text") {
				const nextRef = await this.delegates.uploadTextFile(
					activeCfg,
					recipe.text,
					recipe.filename,
				);
				this.replaceAliases([recipe.currentRef], [nextRef]);
				recipe.currentRef = nextRef;
				continue;
			}
			const nextResult = await this.delegates.resolveAttachments(
				activeCfg,
				recipe.plan,
			);
			const nextRefs = nextResult.fileRefs || [];
			this.replaceAliases(recipe.currentRefs, nextRefs);
			recipe.currentRefs = [...nextRefs];
		}
	}

	remapInput(input: CompletionTextInput): CompletionTextInput {
		if (!input.fileRefs?.length) return input;
		return {
			...input,
			fileRefs: input.fileRefs.map((fileRef) => {
				const key = fileRefKey(fileRef);
				return (key && this.refAliases.get(key)) || fileRef;
			}),
		};
	}

	hasOpaqueRefs(input: CompletionTextInput): boolean {
		return !!input.fileRefs?.some((fileRef) => {
			const key = fileRefKey(fileRef);
			return !key || !this.refAliases.has(key);
		});
	}

	reset(): void {
		this.recipes.length = 0;
		this.refAliases.clear();
	}

	private replaceAliases(
		previous: readonly AttachmentFileRef[],
		next: readonly AttachmentFileRef[],
	): void {
		if (previous.length !== next.length)
			throw uploadReplayError(
				"uploaded file reference count changed during account failover",
			);
		for (let index = 0; index < previous.length; index++) {
			const previousRef = previous[index];
			const nextRef = next[index];
			if (previousRef === undefined || nextRef === undefined)
				throw uploadReplayError(
					"uploaded file reference is missing during account failover",
				);
			const previousKey = fileRefKey(previousRef);
			const nextKey = fileRefKey(nextRef);
			if (!previousKey || !nextKey)
				throw uploadReplayError(
					"uploaded file reference is invalid during account failover",
				);
			for (const [alias, current] of this.refAliases) {
				if (fileRefKey(current) === previousKey)
					this.refAliases.set(alias, nextRef);
			}
			this.refAliases.set(previousKey, nextRef);
			this.refAliases.set(nextKey, nextRef);
		}
	}
}

function fileRefKey(fileRef: AttachmentFileRef): string | null {
	if (typeof fileRef === "string") return fileRef || null;
	const value = fileRef.ref || fileRef.fileRef || fileRef.id;
	return value ? String(value) : null;
}

function uploadReplayError(message: string): ErrorWithMetadata {
	const error: ErrorWithMetadata = new Error(message);
	error.code = "gemini_upload_replay_failed";
	error.status = 502;
	return error;
}
