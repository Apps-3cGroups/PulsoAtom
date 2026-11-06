import { api } from './api.js';

// Catalog reads are keyed by the current selection. Late responses cannot put
// options from an old tool back into the form, even if a transport ignores abort.
export function createGatewayDiscovery({ request = api, onChange }) {
  let active = false, selected = new Set();
  let state = { tools: null, toolsStatus: 'idle', toolsError: null, models: {} };
  const requests = new Map();
  const publish = patch => { state = { ...state, ...patch }; if (active) onChange(state); };
  const cancel = key => { const token = requests.get(key); requests.delete(key); token?.controller.abort(); };
  const begin = key => { cancel(key); const token = { controller: new AbortController() }; requests.set(key, token); return token; };
  const current = (key, token) => active && requests.get(key) === token;
  const modelState = (toolKey, value) => publish({ models: { ...state.models, [toolKey]: value } });

  async function loadModels(toolKey) {
    if (!active || !selected.has(toolKey) || state.toolsStatus !== 'ready') return;
    const key = `models:${toolKey}`, token = begin(key);
    if (!state.tools.some(tool => tool.key === toolKey && tool.status === 'active')) {
      requests.delete(key);
      modelState(toolKey, { status: 'error', error: new Error('Esta herramienta no está activa en el catálogo. Actualiza el Gateway o selecciona otra herramienta.') });
      return;
    }
    modelState(toolKey, { status: 'loading' });
    try {
      const result = await request(`/models/gateway/tools/${encodeURIComponent(toolKey)}/models`, { signal: token.controller.signal, timeoutMs: 190000 });
      if (!Array.isArray(result.models) || result.models.some(model => typeof model !== 'string' || !model)) throw new Error('La herramienta no devolvió una lista válida de modelos.');
      if (current(key, token)) modelState(toolKey, { status: 'ready', items: [...new Set(result.models)] });
    } catch (error) { if (current(key, token)) modelState(toolKey, { status: 'error', error }); }
    finally { if (requests.get(key) === token) requests.delete(key); }
  }

  async function refresh() {
    if (!active) return;
    for (const key of [...requests.keys()]) cancel(key);
    const token = begin('tools');
    publish({ tools: null, toolsStatus: 'loading', toolsError: null, models: {} });
    try {
      const result = await request('/models/gateway/tools', { signal: token.controller.signal, timeoutMs: 190000 });
      if (!Array.isArray(result.tools) || result.tools.some(tool => typeof tool.key !== 'string' || !tool.key || typeof tool.status !== 'string')) throw new Error('El Gateway no devolvió un catálogo válido.');
      if (!current('tools', token)) return;
      publish({ tools: result.tools, toolsStatus: 'ready' });
      await Promise.all([...selected].map(loadModels));
    } catch (error) { if (current('tools', token)) publish({ toolsStatus: 'error', toolsError: error }); }
    finally { if (requests.get('tools') === token) requests.delete('tools'); }
  }

  return {
    start() { active = true; },
    stop() { active = false; for (const key of [...requests.keys()]) cancel(key); },
    select(toolKeys) {
      selected = new Set(toolKeys.filter(Boolean));
      for (const key of [...requests.keys()]) if (key.startsWith('models:') && !selected.has(key.slice(7))) cancel(key);
      publish({ models: Object.fromEntries(Object.entries(state.models).filter(([key]) => selected.has(key))) });
      if (active && state.toolsStatus === 'ready') for (const key of selected) if (!state.models[key]) void loadModels(key);
    },
    refresh,
    retry(toolKey) { return state.tools?.some(tool => tool.key === toolKey && tool.status === 'active') ? loadModels(toolKey) : refresh(); },
  };
}
