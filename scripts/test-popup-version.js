import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
function fixture(replies) {
  const counts = { injections: 0, manifests: 0, sends: 0 };
  let onReady;
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', innerHTML: '', classList: { add() {}, remove() {} }, addEventListener() {} });
    return nodes.get(selector);
  };
  const runtime = { getManifest() { counts.manifests++; return { version: '0.8.1' }; } };
  const context = vm.createContext({
    document: { querySelector: node, addEventListener(name, fn) { onReady = fn; } },
    setTimeout: fn => { fn(); },
    chrome: { runtime,
      tabs: {
        query: (_q, cb) => cb([{ id: 7, url: 'https://www.youtube.com/watch?v=fixture' }]),
        sendMessage: (_id, _message, cb) => {
          const result = replies[Math.min(counts.sends++, replies.length - 1)];
          runtime.lastError = result instanceof Error ? result : undefined;
          cb(result instanceof Error ? undefined : result);
          runtime.lastError = undefined;
        },
      },
      scripting: {
        insertCSS: (_o, cb) => cb(),
        executeScript: (_o, cb) => { counts.injections++; cb(); },
      },
    },
  });
  vm.runInContext(source, context);
  return { context, counts, nodes, onReady };
}

test('matching page and installed versions succeed without reinjection', async () => {
  const f = fixture([{ ok: true, payload: { version: '0.8.1' } }]);
  assert.equal((await f.context.sendPanelMessage(7, 'YLD_PANEL_STATUS', true)).ok, true);
  assert.equal(f.counts.manifests, 1);
  assert.equal(f.counts.injections, 0);
});

test('old, newer and missing page versions request refresh instead of claiming success', async () => {
  for (const version of ['0.8.0', '0.9.0', undefined]) {
    const f = fixture([{ ok: true, payload: { version } }]);
    await assert.rejects(f.context.sendPanelMessage(7, 'YLD_PANEL_STATUS', true), /새로고침\(F5\)/);
    assert.equal(f.counts.injections, 0);
  }
});

test('missing content is injected once and then checked against the installed version', async () => {
  const f = fixture([new Error('Could not establish connection. Receiving end does not exist.'), { ok: true, payload: { version: '0.8.1' } }]);
  assert.equal((await f.context.sendPanelMessage(7, 'YLD_PANEL_STATUS', true)).ok, true);
  assert.equal(f.counts.injections, 1);
  assert.equal(f.counts.sends, 2);
});

test('stale readiness/no receiver and invalidated extension context give bounded refresh recovery', async () => {
  for (const message of ['Receiving end does not exist', 'Extension context invalidated', 'The message port closed before a response was received']) {
    const f = fixture([new Error(message)]);
    await assert.rejects(f.context.sendPanelMessage(7, 'YLD_PANEL_STATUS', true), /페이지 연결이 끊겼습니다.*새로고침\(F5\)/);
    assert.equal(f.counts.injections, 1);
    assert.equal(f.counts.sends, 2);
  }
});

test('popup header and status display the real installed/page versions', async () => {
  const f = fixture([{ ok: true, payload: { version: '0.8.1', visible: true } }]);
  f.onReady();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.nodes.get('[data-version]').textContent, 'v0.8.1');
  assert.match(f.nodes.get('[data-details]').innerHTML, /설치 버전:.*0\.8\.1/);
  assert.match(f.nodes.get('[data-details]').innerHTML, /페이지 버전:.*0\.8\.1/);
});
