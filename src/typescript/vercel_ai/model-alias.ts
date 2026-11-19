/**
 * The model name the workflows ask for. Workflow code can't read the environment, so the worker's
 * provider (geminiProvider in gemini.ts) maps this name to GEMINI_MODEL. Kept in its own file so
 * workflow code can import it without the Gemini SDK.
 */
export const GEMINI_MODEL_ALIAS = 'gemini';
