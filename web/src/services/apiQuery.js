import { api } from './api.js';

// Schedule the next read only after the previous one settles. A slow response
// must never be aborted by its own polling interval.
export function startApiQuery(path, { timeoutMs, pollIntervalMs = 0, pollWhile, onData, onError, onLoading }) {
  let active = true, timer = null, controller = null;
  const read = async () => {
    controller = new AbortController();
    onLoading(true); onError(null);
    try {
      const data = await api(path, { signal: controller.signal, timeoutMs });
      if (!active) return;
      onData(data);
      if (pollIntervalMs > 0 && pollWhile?.(data)) timer = setTimeout(read, pollIntervalMs);
    } catch (error) {
      if (active) onError(error);
      // An error pauses polling; retry is an explicit new read, never inference.
    } finally {
      if (active) onLoading(false);
    }
  };
  read();
  return () => { active = false; clearTimeout(timer); controller?.abort(); };
}
