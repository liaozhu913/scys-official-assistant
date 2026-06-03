const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const scriptPath = path.resolve(__dirname, '..', '生财有术看图助手-1.1.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');

assert.match(source, /@name\s+生财有术看图助手/);
assert.match(source, /@version\s+1\.1/);
assert.match(source, /@author\s+料主（liaozhu913）/);
assert.match(source, /@description\s+图片增强/);
assert.doesNotMatch(source, /@description[^\n]*Markdown/);
assert.match(source, /@grant\s+GM_registerMenuCommand/);
assert.match(source, /@grant\s+GM_getValue/);
assert.match(source, /@grant\s+GM_setValue/);
assert.match(source, /scys-helper-mdbar-visible/);
assert.match(source, /显示高级功能浮窗按钮/);
assert.doesNotMatch(source, /页面右下角会显示 Markdown/);
assert.doesNotMatch(source, /GM_registerMenuCommand\('查看 Markdown/);
assert.doesNotMatch(source, /GM_registerMenuCommand\('复制 Markdown/);
assert.doesNotMatch(source, /GM_registerMenuCommand\('下载 Markdown/);
const copyTextBody = source.slice(source.indexOf('async function copyText'), source.indexOf('function openPreview'));
assert.ok(copyTextBody.indexOf('navigator.clipboard.writeText') < copyTextBody.indexOf('copyTextWithTextArea(text)'));
assert.ok(copyTextBody.indexOf('copyTextWithTextArea(text)') < copyTextBody.indexOf('GM_setClipboard(text,'));

class Node {
  constructor(type) {
    this.nodeType = type;
  }
}
Node.ELEMENT_NODE = 1;
Node.TEXT_NODE = 3;

const fakeDocument = {
  body: {
    appendChild() {},
    classList: { add() {}, remove() {} },
  },
  addEventListener() {},
  createElement() {
    return {
      addEventListener() {},
      appendChild() {},
      classList: { add() {}, remove() {} },
      dataset: {},
      setAttribute() {},
      style: {},
    };
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
};

function hmac16(payload) {
  return nodeCrypto
    .createHmac('sha256', 'NW_LICENSE_KEY_2026_AntiGravity#$%')
    .update(payload)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();
}

const context = {
  Blob,
  Node,
  TextEncoder,
  TextDecoder,
  URL,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  btoa: value => Buffer.from(value, 'binary').toString('base64'),
  console,
  process,
  GM_getValue(key, defaultValue) {
    return Object.prototype.hasOwnProperty.call(context.gmStore, key) ? context.gmStore[key] : defaultValue;
  },
  GM_setValue(key, value) {
    context.gmStore[key] = value;
  },
  gmStore: {},
  crypto: {
    subtle: {
      async importKey(_format, keyBytes) {
        return Buffer.from(keyBytes);
      },
      async sign(_algorithm, key, payloadBytes) {
        return nodeCrypto.createHmac('sha256', key).update(Buffer.from(payloadBytes)).digest();
      },
    },
  },
  document: fakeDocument,
  location: { href: 'https://scys.com/articleDetail/xq_topic/45544588822582158' },
  navigator: {
    clipboard: {
      async writeText(text) {
        context.nativeClipboardText = text;
      },
    },
  },
  window: {
    __SCYS_OFFICIAL_ASSISTANT_TEST__: true,
    addEventListener() {},
    clearTimeout() {},
    setTimeout() {},
    location: { href: 'https://scys.com/articleDetail/xq_topic/45544588822582158' },
  },
};
context.window.window = context.window;
context.window.document = fakeDocument;
context.window.Node = Node;
context.window.navigator = context.navigator;
context.globalThis = context.window;

vm.runInNewContext(source, context, { filename: scriptPath });

const helpers = context.window.__SCYSOfficialAssistantTest;
assert.equal(typeof helpers.normalizeImageUrl, 'function');
assert.equal(typeof helpers.isViewableImage, 'function');
assert.equal(typeof helpers.verifyMarkdownUnlockKey, 'function');
assert.equal(typeof helpers.buildMarkdownUnlockKey, 'function');
assert.equal(typeof helpers.buildMarkdownFromPage, 'function');
assert.equal(typeof helpers.copyText, 'function');
assert.equal(typeof helpers.isMarkdownBarEnabled, 'function');
assert.equal(typeof helpers.setMarkdownBarEnabled, 'function');

(async () => {
  assert.equal(helpers.isMarkdownBarEnabled(), true);
  helpers.setMarkdownBarEnabled(false);
  assert.equal(helpers.isMarkdownBarEnabled(), false);
  helpers.setMarkdownBarEnabled(true);
  assert.equal(helpers.isMarkdownBarEnabled(), true);

  const datePart = '20260603';
  const deviceCode = 'ABCD-EFGH-1234-5678';
  const userInfo = '料主测试用户';
  const expected = await helpers.buildMarkdownUnlockKey(deviceCode, userInfo, datePart);
  const userPart = Buffer.from(userInfo, 'utf8').toString('base64url');
  assert.equal(expected, `SCYS-MD2-${deviceCode}-${datePart}-${userPart}-${hmac16(`SCYS_OFFICIAL_ASSISTANT|MD_UNLOCK_V2|${deviceCode}|${datePart}|${userPart}`)}`);
  assert.equal(await helpers.verifyMarkdownUnlockKey(expected, deviceCode), true);
  assert.equal(await helpers.verifyMarkdownUnlockKey(expected, 'ZZZZ-EFGH-1234-5678'), false);
  assert.equal(await helpers.verifyMarkdownUnlockKey('SCYS-MD-20260603-BAD', deviceCode), false);

  context.nativeClipboardText = '';
  await helpers.copyText('hello native');
  assert.equal(context.nativeClipboardText, 'hello native');

  let gmClipboardText = '';
  context.navigator.clipboard.writeText = async () => {
    throw new Error('native unavailable');
  };
  fakeDocument.execCommand = () => false;
  context.GM_setClipboard = text => {
    gmClipboardText = text;
  };
  await helpers.copyText('hello md');
  assert.equal(gmClipboardText, 'hello md');

  const normalized = helpers.normalizeImageUrl(
    'https://sphere-search-mobile.oss-cn-shanghai.aliyuncs.com/upload/doc/blocks/a?x-oss-process=image/auto-orient,1/resize,m_lfit,w_1280,h_16000/quality,q_75/format,webp'
  );
  const process = new URL(normalized).searchParams.get('x-oss-process');
  assert.match(process, /w_2400/);
  assert.match(process, /quality,q_95/);

  console.log('scys-official-assistant tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
