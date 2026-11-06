import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { startApiQuery } from './services/apiQuery.js';

export const PortalContext = createContext(null);
export const usePortal = () => useContext(PortalContext);
export function useApi(path, { timeoutMs, pollIntervalMs = 0, pollWhile } = {}) {
  const [data, setData] = useState(null);
  const [dataPath, setDataPath] = useState(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState(null);
  const [iteration, setIteration] = useState(0);
  const reload = useCallback(() => setIteration(n => n + 1), []);
  useEffect(() => {
    if (!path) { setData(null); setError(null); setLoading(false); return; }
    return startApiQuery(path, { timeoutMs, pollIntervalMs, pollWhile, onLoading: setLoading, onError: setError,
      onData: value => { setData(value); setDataPath(path); } });
  }, [path, iteration, timeoutMs, pollIntervalMs, pollWhile]);
  return { data, dataPath, loading, error, reload };
}
export function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timeout = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timeout); }, [value, delay]);
  return debounced;
}
