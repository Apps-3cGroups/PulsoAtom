export function startEvaluationHeartbeat(writeHeartbeat, { setInterval: schedule = setInterval, clearInterval: cancel = clearInterval } = {}) {
  let pending = null, stopped = false;
  const timer = schedule(() => {
    if (stopped || pending) return;
    // Keep at most one write queued or running, including synchronous failures.
    pending = Promise.resolve().then(writeHeartbeat).catch(() => {}).finally(() => { pending = null; });
  }, 30_000);
  timer.unref();
  return async () => {
    stopped = true;
    cancel(timer);
    // A caller may close the store as soon as the evaluation resolves.
    await pending;
  };
}
