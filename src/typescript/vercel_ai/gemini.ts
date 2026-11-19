import { customProvider } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { GEMINI_MODEL_ALIAS } from './model-alias';

/**
 * The Gemini API key: GEMINI_API_KEY, which the shared scripts/setgeminikey.sh sets for every framework
 * that uses Gemini, or the Vercel AI SDK's own GOOGLE_GENERATIVE_AI_API_KEY.
 */
export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || undefined;
}

/** The Gemini provider, created on first use so that a missing key only fails the model call. */
let provider: ReturnType<typeof createGoogleGenerativeAI> | undefined;
export function gemini(): ReturnType<typeof createGoogleGenerativeAI> {
  provider ??= createGoogleGenerativeAI({ apiKey: geminiApiKey() });
  return provider;
}

export { GEMINI_MODEL_ALIAS };

/** The default Gemini model. Override it with GEMINI_MODEL. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** The Gemini model the agents use: GEMINI_MODEL, or DEFAULT_GEMINI_MODEL. */
export function geminiModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

/**
 * The provider the worker gives the AiSdkPlugin. Workflow code can't read the environment, so the
 * workflows ask for the model GEMINI_MODEL_ALIAS and this provider, which runs in the model
 * activity, turns that into geminiModel(). Any other name goes to Gemini unchanged.
 */
export function geminiProvider() {
  return customProvider({
    languageModels: { [GEMINI_MODEL_ALIAS]: gemini()(geminiModel()) },
    fallbackProvider: gemini(),
  });
}
