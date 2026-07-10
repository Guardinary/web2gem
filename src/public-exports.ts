// Stable public helper surface.
export { VERSION, assertRuntimeConfig } from "./config";
export { MODELS, resolveModel } from "./models";
export { generate, generateStream } from "./gemini/client";
export { parseToolCalls } from "./toolcall";
