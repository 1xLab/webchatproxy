import { dirname } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export function loadCooldowns(file, workers, now = Date.now()) {
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }

  let changed = false;
  for (const worker of workers) {
    const value = Number(state?.accounts?.[String(worker.index + 1)] || 0);
    if (value > now) worker.failedUntil = value;
    else if (value) changed = true;
  }
  return changed;
}

export function persistCooldowns(file, workers, now = Date.now()) {
  const accounts = Object.fromEntries(
    workers
      .filter(worker => worker.failedUntil > now)
      .map(worker => [String(worker.index + 1), worker.failedUntil]),
  );
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, `${JSON.stringify({ version: 1, accounts })}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
