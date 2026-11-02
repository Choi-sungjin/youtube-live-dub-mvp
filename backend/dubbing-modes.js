export const DUBBING_MODES = Object.freeze({
  local: { translationProvider: 'ollama', ttsProvider: 'supertonic3' },
  'gemma-gpt': { translationProvider: 'ollama', ttsProvider: 'openai-realtime' },
  'gpt-local': { translationProvider: 'openai', ttsProvider: 'supertonic3' },
  gpt: { translationProvider: 'openai', ttsProvider: 'openai-realtime' },
});

export function resolveDubbingMode(mode) {
  if (!Object.hasOwn(DUBBING_MODES, mode)) {
    const error = new Error('Unknown dubbing mode. Choose one of the four available modes.');
    error.statusCode = 400;
    throw error;
  }
  return DUBBING_MODES[mode];
}
