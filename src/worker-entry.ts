import { handleApplicationRequest } from "./app";
import { assertRuntimeConfig } from "./config";

export default {
	fetch: handleApplicationRequest,
	assertRuntimeConfig,
};
