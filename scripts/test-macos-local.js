import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMissingSettings } from './macos-local.mjs';

test('Mac setup preserves existing providers, secrets, model choice and installation identity', () => {
  const previous = '# local settings\r\nOPENAI_API_KEY="fixture-only"\r\nOLLAMA_MODEL=custom-model\r\nTRANSLATION_PROVIDER=openai\r\nYLD_INSTALLATION_ID=existing';
  const result = addMissingSettings(previous, {
    OLLAMA_MODEL: 'default', TRANSLATION_PROVIDER: 'ollama',
    YLD_INSTALLATION_ID: 'new', YLD_STT_DEVICE: 'cpu'
  });
  assert.equal(result, previous + '\nYLD_STT_DEVICE=cpu\n');
});

test('Mac setup is idempotent and does not treat commented settings as configured', () => {
  const defaults = { HOST: '127.0.0.1', PORT: '18789' };
  const first = addMissingSettings('# HOST=0.0.0.0\n', defaults);
  assert.equal(first, '# HOST=0.0.0.0\nHOST=127.0.0.1\nPORT=18789\n');
  assert.equal(addMissingSettings(first, defaults), first);
});

test('Mac setup preserves explicitly empty or spaced configuration values', () => {
  const original = ' OPENAI_API_KEY =\n OLLAMA_MODEL = "custom"\n';
  assert.equal(addMissingSettings(original, { OPENAI_API_KEY: 'unused', OLLAMA_MODEL: 'unused' }), original);
});
