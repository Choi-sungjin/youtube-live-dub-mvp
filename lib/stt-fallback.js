export async function transcribeWithFallback(fast, legacy, warn = console.warn) {
  try { return await fast(); }
  catch (error) {
    warn(`Fast STT unavailable; using installed Whisper: ${error.message}`);
    return legacy();
  }
}
