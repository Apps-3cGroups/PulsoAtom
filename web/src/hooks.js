import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './services/api';

export const PortalContext = createContext(null);
export const usePortal = () => useContext(PortalContext);
export function useApi(path) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState(null);
  const [iteration, setIteration] = useState(0);
  const reload = useCallback(() => setIteration(n => n + 1), []);
  useEffect(() => {
    if (!path) { setData(null); setError(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(null);
    api(path, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setData(value); }).catch(reason => { if (!controller.signal.aborted) setError(reason); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, iteration]);
  return { data, loading, error, reload };
}
export function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timeout = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timeout); }, [value, delay]);
  return debounced;
}
