import { createGoogleGenerativeAI } from '@ai-sdk/google';

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
