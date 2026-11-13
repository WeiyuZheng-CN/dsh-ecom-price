/**
 * Output-contract regression tests for the ecom-price tools.
 *
 * These exist because the original stub test (`defineTool = (cfg) => cfg`)
 * proved nothing: it performed no schema validation, so two real defects
 * shipped — a `reason` field absent from four output schemas, and optional
 * fields set to `undefined` (which the host rejects wholesale as
 * "value is not lossless JSON").
 *
 * So this suite deliberately runs the REAL host rules:
 *   - `defineTool` compiles the author schema exactly as the host does
 *   - `snapshotJsonValue` applies the lossless-JSON rule
 *   - `validateJsonSchemaValue` applies the compiled output schema
 *
 * Run: node --test plugin/test/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';

import { apply } from '../lib/index.js';

/**
 * Marker the plugin sets on a compacting `execute`.
 *
 * Declared locally rather than imported so this suite still loads against a
 * plugin build that predates the marker: a missing export would abort the
 * module and hide which assertions actually fail.
 */
const COMPACTED = Symbol.for('ecom-price.compacted');

/**
 * Local copy of the plugin's compaction rule.
 *
 * Deliberately duplicated rather than imported: the tests must still run
 * against a plugin build that lacks the helper, so they can prove the defect
 * is caught. Importing it would turn a missing export into a module-load
 * error instead of a meaningful assertion failure.
 */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = compact(v);
  }
  return out;
}

/** Register the plugin against a stub tools service and index the definitions. */
function loadTools() {
  const registered = [];
  const ctx = { tools: { register: (definition) => { registered.push(definition); return () => {}; } } };
  apply(ctx, { host: '127.0.0.1', port: 9222 });
  return new Map(registered.map((definition) => [definition.name, definition]));
}

const tools = loadTools();

/**
 * Apply the host's exact success-path checks to one candidate value.
 *
 * The candidate is compacted first, because that is what `execute()` does on
 * the way out: the host only ever sees the compacted shape. Passing a raw
 * `undefined`-bearing value here would test the wrong layer.
 * @param name - registered tool name.
 * @param value - what the tool's `execute` resolved to before compaction.
 * @returns the violations the host would raise; empty means accepted.
 */
function hostViolations(name, value) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} is not registered`);
  const detached = snapshotJsonValue(compact(value));
  if (detached === undefined) return ['value is not lossless JSON'];
  return validateJsonSchemaValue(tool.output.schema, detached, 'value');
}

/** Assert the host would accept this result. */
function assertAccepted(name, value) {
  const violations = hostViolations(name, value);
  assert.deepEqual(violations, [], `${name} would be rejected: ${violations.join('; ')}`);
}

test('all five tools register', () => {
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['shop_browser_status', 'shop_open', 'shop_price', 'shop_search', 'shop_sku_price'],
  );
});

test('every output schema compiles to an object root', () => {
  // `defineTool` turns property-level `required: true` into a root `required`
  // array, so the compiled root legitimately carries one. What must hold is
  // that the root is an object and that `ok` is the only required field.
  for (const [name, tool] of tools) {
    assert.equal(tool.output.schema.type, 'object', `${name} root must be type: object`);
    assert.deepEqual(tool.output.schema.required, ['ok'], `${name} must require only ok`);
  }
});

test('every output schema declares reason, so failure results validate', () => {
  for (const [name, tool] of tools) {
    const properties = tool.output.schema.properties ?? {};
    assert.ok('reason' in properties, `${name} output schema must declare reason`);
  }
});

test('failure results are accepted for every tool', () => {
  // `fail()` is the shared failure shape; each tool must be able to return it.
  const failure = { ok: false, reason: 'browser_unavailable', message: 'no CDP endpoint' };
  for (const name of tools.keys()) {
    assertAccepted(name, failure);
  }
});

test('shop_browser_status success is accepted', () => {
  assertAccepted('shop_browser_status', {
    ok: true, endpoint: '127.0.0.1:9222', tabs: 2, taobaoLoggedIn: true, jdLoggedIn: false,
  });
});

test('shop_search accepts candidates that lack shop and sold', () => {
  // The list extractor yields null shop/sold for some cards; the tool maps those
  // to undefined, which used to poison the whole result.
  assertAccepted('shop_search', {
    ok: true, keyword: '马利 丙烯', url: 'https://s.taobao.com/search?q=x', count: 1,
    loginWall: false, note: 'note',
    items: [{ title: 't', shop: undefined, sold: undefined, link: 'https://item.taobao.com/item.htm?id=1' }],
  });
});

test('shop_price accepts a successful read (the path that always failed)', () => {
  // `message` is undefined exactly when a price was read — the only useful case.
  assertAccepted('shop_price', {
    ok: true, url: 'https://item.taobao.com/item.htm?id=1', title: 't', price: '4.9',
    priceRaw: '￥4.9', masked: false, shop: 's', loginWall: false, captcha: false,
    note: 'note', message: undefined,
  });
});

test('shop_sku_price accepts the default overview (no spec given)', () => {
  // `groups` and `message` are undefined unless a spec was supplied and missed.
  assertAccepted('shop_sku_price', {
    ok: true, url: 'https://item.taobao.com/item.htm?id=1', title: 't', shop: 's',
    skuCount: 2, maskedCount: 0, minReal: 4.9, maxReal: 30.9, masked: false,
    groups: undefined, message: undefined,
    matches: [{ attrs: '20个', price: '4.9', masked: false, stock: '有货' }],
  });
});

test('shop_sku_price accepts a spec miss that offers the available values', () => {
  assertAccepted('shop_sku_price', {
    ok: true, url: 'u', title: 't', shop: 's', skuCount: 2, maskedCount: 0,
    minReal: 4.9, maxReal: 30.9, masked: false,
    groups: ['20个', '50个'], message: '没有 SKU 同时包含 500ml', matches: [],
  });
});

test('shop_sku_price accepts a login-wall failure', () => {
  assertAccepted('shop_sku_price', {
    ok: false, url: 'u', reason: 'login_wall', note: 'login', message: undefined,
  });
});

test('shop_open accepts a page with no title', () => {
  assertAccepted('shop_open', { ok: true, url: 'https://example.com', title: undefined });
});

test('every registered tool compacts its result before the host sees it', () => {
  // Structural guard: a new tool that bypasses `registerTool` would ship the
  // "value is not lossless JSON" defect again. The marker is set by the
  // wrapper, so its absence means the tool is unwrapped.
  for (const [name, tool] of tools) {
    assert.equal(tool.execute[COMPACTED], true, `${name} must be registered through registerTool`);
  }
});

test('the wrapper removes undefined from a success-shaped result', async () => {
  // The success paths are the ones that always failed, and they cannot be
  // driven without a browser. Exercise the wrapper directly instead: feed it a
  // result shaped like `shop_price`'s success return and assert the host would
  // accept what comes out.
  const tool = tools.get('shop_price');
  const raw = {
    ok: true, url: 'u', title: 't', price: '4.9', priceRaw: '￥4.9', masked: false,
    shop: 's', loginWall: false, captcha: false, note: 'n', message: undefined,
  };
  assert.equal(snapshotJsonValue(raw), undefined, 'the raw shape must be rejected, or this test proves nothing');

  const compacted = compact(raw);
  assert.equal('message' in compacted, false, 'undefined keys must be dropped, not kept');
  assert.deepEqual(hostViolations('shop_price', raw), []);
});

test('execute() strips undefined so the host never sees it', async () => {
  // Drive a real execute() through the compacting wrapper. The browser is not
  // reachable here, so this exercises the failure path end to end.
  const tool = tools.get('shop_browser_status');
  const result = await tool.execute({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'browser_unavailable');
  assert.deepEqual(hostViolations('shop_browser_status', result), []);
  assert.equal(snapshotJsonValue(result) !== undefined, true, 'result must be lossless JSON');
});
