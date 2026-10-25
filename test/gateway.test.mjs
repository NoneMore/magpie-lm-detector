import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGatewayURL, gatewaySettings, discoverGateway, listModels } from '../src/gateway.mjs';

test('Gateway URL validation permits only safe endpoints', () => {
  assert.equal(normalizeGatewayURL('http://127.0.0.1:3425'), 'http://127.0.0.1:3425/v1');
  assert.equal(normalizeGatewayURL('http://localhost:3425/v1/'), 'http://localhost:3425/v1');
  assert.equal(normalizeGatewayURL('https://example.com/v1', { allowRemote: true }), 'https://example.com/v1');
  for (const value of ['file:///x','http://evil.com','https://evil.com/v1','http://user:pass@localhost/v1','http://127.0.0.1:3425/v1?key=123','http://localhost/api/proxy']) {
    assert.throws(() => normalizeGatewayURL(value), /Gateway/);
  }
  assert.throws(() => normalizeGatewayURL('http://example.com', { allowRemote: true }), /HTTPS/);
  assert.deepEqual(gatewaySettings({ url: 'http://127.0.0.1:3425', key: 'abc' }), { url: 'http://127.0.0.1:3425/v1', key: 'abc' });
  assert.throws(() => gatewaySettings({ url: 'http://localhost' }), /Key/);
});

test('auto-discovery does not leak implicit default key to remote address', async () => {
  let requested = 0;
  const fakeFetch = async url => { requested++; assert.match(url, /127\.0\.0\.1/); return new Response(JSON.stringify({ data: [] })); };
  assert.equal(await discoverGateway({}, { MAGPIE_ADDR: 'https://remote.example.com' }, fakeFetch), null);
  assert.equal(requested, 0);
  assert.deepEqual(await discoverGateway({ gatewayURL: 'http://127.0.0.1:3425' }, {}, fakeFetch),
    { url: 'http://127.0.0.1:3425/v1', key: 'magpie' });
  assert.equal(requested, 1);
});

test('models list filters routing groups, malformed names and duplicate ids', async () => {
  const result = await listModels({ url:'http://localhost:3425/v1',key:'abc' }, async (url, init) => {
    assert.equal(url, 'http://localhost:3425/v1/models');
    assert.equal(init.headers.Authorization, 'Bearer abc');
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({data:[
      { id:'a/z' },{ id:'a/z' },{id:'b/y'},{id:'group/test'},{id:'auto/gpt'},
      {id:'noSlash'},{id:'bad model/z'},{id:'quality-probe/secret'},
    ]}));
  });
  assert.deepEqual(result,['a/z','b/y']);
});
