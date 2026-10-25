// Run with Bun in CI: prove both the real npm SDK and the plugin hooks load.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import plugin from '../index.mjs';
import { generateChallenges, loadDetector } from 'lmfpd-sdk';

const dir = await mkdtemp(path.join(os.tmpdir(), 'lmfpd-bun-smoke-'));
try {
  assert.equal(plugin.id, 'magpie-lm-detector-external');
  assert.equal(typeof loadDetector, 'function');
  assert.equal(generateChallenges(1).length, 1);
  const hooks = await plugin.server({}, { dataDir: dir });
  const config = {};
  await hooks.config(config);
  assert.ok(config.provider['magpie-lm-detector-external']);
  const entry = await hooks.auth.methods[0].authorize();
  assert.ok(entry.url.startsWith('http://127.0.0.1:'));
  const response = await fetch(entry.url, { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
  console.log('PASS: Bun plugin entrypoint, auth link, server and real SDK imports');
} finally {
  await rm(dir, { recursive: true, force: true });
  // The real Magpie host is deliberately long-lived. This smoke harness exits.
  process.exit(0);
}
