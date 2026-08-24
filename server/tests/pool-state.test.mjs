import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadCooldowns, persistCooldowns } from '../providers/antigravity/pool-state.mjs';

test('pool cooldowns survive restart and expired entries are pruned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webchatproxy-pool-'));
  const file = join(root, 'antigravity-pool', 'cooldowns.json');
  const workers = [
    { index: 0, failedUntil: 0 },
    { index: 1, failedUntil: 0 },
    { index: 2, failedUntil: 0 },
  ];
  const now = 1_000_000;

  workers[0].failedUntil = now + 3_600_000;
  persistCooldowns(file, workers, now);
  await writeFile(file, JSON.stringify({ version: 1, accounts: { '1': now + 3_600_000, '2': now - 1 } }));

  const restored = workers.map(worker => ({ ...worker, failedUntil: 0 }));
  assert.equal(loadCooldowns(file, restored, now), true);
  assert.equal(restored[0].failedUntil, now + 3_600_000);
  assert.equal(restored[1].failedUntil, 0);
  assert.equal(restored[2].failedUntil, 0);

  persistCooldowns(file, restored, now);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    version: 1,
    accounts: { '1': now + 3_600_000 },
  });
  await rm(root, { recursive: true, force: true });
});
