import { handleApplicationRequest } from "./app";

export default {
	fetch: handleApplicationRequest,
} satisfies ExportedHandler<WorkerBindings>;

export * from "./public-exports";
