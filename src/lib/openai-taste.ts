import { MAX_INPUT_BYTES, type TasteContext } from './taste-context';
import { PROFILE_FORMAT } from './taste-schema';
import { requestStructuredOutput, type OpenAIOptions } from './openai';
export { parseUsage, requireOpenAIConfig, MAX_OUTPUT_TOKENS, OPENAI_TIMEOUT_MS, type Usage, type OpenAIResult } from './openai';

export function requestTasteProfile(context: TasteContext, options: OpenAIOptions) {
  return requestStructuredOutput({ input: context.input, format: context.format ?? PROFILE_FORMAT, maxInputBytes: MAX_INPUT_BYTES }, options);
}
