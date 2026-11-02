import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = name => readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const validSender = { id: 'fixture-extension', tab: { id: 7 }, frameId: 0,
  documentId: 'document-A', url: 'https://www.youtube.com/watch?v=fixture' };
const payload = { requestId: 'request-A', mode: 'snapshot', targetLang: 'ko' };
const plain = value => JSON.parse(JSON.stringify(value));
function background(execute) {
  let listener;
  const context = vm.createContext({ URL, chrome: {
    runtime: { id: validSender.id, onMessage: { addListener(fn) { listener = fn; } } },
    scripting: { executeScript: execute },
  } });
  context.importScripts = name => vm.runInContext(source(name), context);
  vm.runInContext(source('background.js'), context);
  return (data = payload, sender = validSender) => new Promise(resolve => {
    assert.equal(listener({ type: 'YLD_PAGE_PROBE', payload: data }, sender, resolve), true);
  });
}
function pageFixture() {
  const messages = [];
  const context = vm.createContext({ URL, location: { href: validSender.url },
    document: { querySelector: () => null },
    XMLHttpRequest: class { open() {} send() {} },
    window: { postMessage: data => messages.push(plain(data)),
      ytInitialPlayerResponse: { videoDetails: { videoId: 'fixture' } } },
  });
  return { messages, context };
}

test('all probe modes execute the serialized function in the sender document with correlated replies', async () => {
  const { context, messages } = pageFixture();
  // A cached caption completes prime-captions without timers or network calls.
  context.window.__YLD_TRANSCRIPT_CACHE__ = { fixture: { segments: [{ start: 0, end: 1, text: 'Hello' }, { start: 1, end: 2, text: 'World' }] } };
  const call = background(async options => {
    assert.deepEqual(plain(options.target), { tabId: 7, documentIds: ['document-A'] });
    assert.equal(options.world, 'MAIN');
    assert.equal(options.files, undefined);
    const result = vm.runInContext(`(${options.func.toString()})(${JSON.stringify(options.args[0])})`, context);
    return [{ frameId: 0, documentId: 'document-A', result }];
  });
  for (const mode of ['install', 'snapshot', 'fetch-transcript', 'prime-captions']) {
    const requestId = `request-${mode}`;
    const response = await call({ ...payload, requestId, mode });
    assert.equal(response.ok, true, response.error);
    assert.deepEqual(plain(response.payload), { requestId, mode, videoId: 'fixture' });
    assert.ok(messages.some(m => m.type === 'PLAYER_RESPONSE' && m.requestId === requestId && m.response.videoDetails.videoId === 'fixture'));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.some(m => m.source === 'YLD_PAGE' && m.type === 'TRANSCRIPT_RESPONSE' && m.requestId === 'request-fetch-transcript'));
  assert.ok(messages.some(m => m.source === 'YLD_PAGE' && m.type === 'CAPTIONS_PRIMED' && m.requestId === 'request-prime-captions' && m.segments[0]?.text === 'Hello'));
});

test('foreign senders, subframes and malformed requests never execute code', async () => {
  let executions = 0;
  const call = background(async () => { executions++; return []; });
  for (const sender of [undefined, {}, { ...validSender, id: 'other' }, { ...validSender, tab: null },
    { ...validSender, documentId: undefined }, { ...validSender, documentId: '' },
    { ...validSender, frameId: 1 }, { ...validSender, url: 'https://www.youtube.com.evil.test/' },
    { ...validSender, url: 'http://www.youtube.com/' }, { ...validSender, url: 'https://www.youtube.com:444/' }]) {
    const response = await call(payload, sender || {});
    assert.equal(response.ok, false);
  }
  for (const data of [null, {}, { ...payload, mode: 'arbitrary-code' }, { ...payload, requestId: '' },
    { ...payload, requestId: 'x'.repeat(201) }, { ...payload, targetLang: 'zz' }]) {
    assert.equal((await call(data)).ok, false);
  }
  assert.equal(executions, 0);
});

test('boundary request works without trusting extra target/code fields', async () => {
  const call = background(async options => {
    assert.deepEqual(plain(options.target), { tabId: 7, documentIds: ['document-A'] });
    assert.equal(options.args[0].tabId, undefined);
    assert.equal(options.args[0].code, undefined);
    return [{ result: { ...options.args[0], videoId: 'fixture' } }];
  });
  assert.equal((await call({ ...payload, requestId: 'x'.repeat(200), tabId: 999, code: 'bad' },
    validSender)).ok, true);
});

test('injection failures and missing acknowledgements are reported as failures', async () => {
  for (const execute of [async () => { throw new Error('Document was unloaded'); }, async () => [],
    async () => [{ result: { requestId: 'stale', mode: 'snapshot' } }]]) {
    const response = await background(execute)();
    assert.equal(response.ok, false);
    assert.ok(response.error);
  }
});

test('content bridge reports failures without throwing or creating extension script elements', async () => {
  const text = source('content.js');
  const start = text.indexOf('  async function injectPageProbe(');
  const end = text.indexOf('\n  function handlePageMessage', start);
  for (const sendMessage of [async () => ({ ok: true }), async () => ({ ok: false, error: 'Denied' }),
    async () => { throw new Error('Extension context invalidated'); }]) {
    const context = vm.createContext({ chrome: { runtime: { sendMessage } }, state: {}, els: {}, renderPlaybackDiagnostics() {} });
    vm.runInContext(text.slice(start, end), context);
    const ok = await context.injectPageProbe('request', 'install');
    assert.equal(context.state.pageProbeStatus.startsWith(ok ? '연결됨' : '연결 실패:'), true);
  }
  assert.doesNotMatch(text, /getURL\(["']page-probe\.js/);
});
