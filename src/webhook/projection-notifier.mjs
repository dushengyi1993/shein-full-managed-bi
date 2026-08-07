import { writeFile } from 'node:fs/promises';

function positiveInteger(value, fallback, { minimum = 1_000, maximum = 300_000 } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`Webhook projection interval must be ${minimum}..${maximum} ms.`);
  }
  return parsed;
}

/**
 * Coalesce bursts of Webhook completions into fixed, non-secret systemd path
 * markers. The worker never starts another service and never writes Dashboard
 * payloads; root-owned path units cross the privilege boundary.
 */
export function createWebhookProjectionNotifier({
  dashboardMarker,
  hydrationMarker,
  minimumIntervalMs = 30_000,
  writeMarker = (file, value) => writeFile(file, value, { mode: 0o600 }),
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
} = {}) {
  if (typeof dashboardMarker !== 'string' || dashboardMarker.trim() === '') {
    throw new TypeError('dashboardMarker is required.');
  }
  if (typeof hydrationMarker !== 'string' || hydrationMarker.trim() === '') {
    throw new TypeError('hydrationMarker is required.');
  }
  const interval = positiveInteger(minimumIntervalMs, 30_000);
  let dashboardPending = false;
  let hydrationPending = false;
  let lastFlushedAt = Number.NEGATIVE_INFINITY;
  let timer = null;
  let writeChain = Promise.resolve();

  function flush() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (!dashboardPending && !hydrationPending) return writeChain;
    const dashboard = dashboardPending;
    const hydration = hydrationPending;
    dashboardPending = false;
    hydrationPending = false;
    lastFlushedAt = now();
    const value = `${new Date(lastFlushedAt).toISOString()}\n`;
    writeChain = writeChain.then(async () => {
      try {
        if (dashboard) await writeMarker(dashboardMarker, value);
        if (hydration) await writeMarker(hydrationMarker, value);
      } catch (error) {
        logger.error?.(JSON.stringify({
          event: 'webhook-projection-notify-failed',
          errorCode: String(error?.code ?? 'WEBHOOK_NOTIFY_FAILED').slice(0, 80),
        }));
      }
    });
    return writeChain;
  }

  function request({ hydration = false } = {}) {
    dashboardPending = true;
    hydrationPending ||= hydration === true;
    const waitMs = Math.max(0, interval - (now() - lastFlushedAt));
    if (waitMs === 0) return flush();
    if (!timer) timer = setTimer(() => { void flush(); }, waitMs);
    return writeChain;
  }

  async function stop() {
    await flush();
    await writeChain;
  }

  return Object.freeze({ request, flush, stop });
}
