import { useEffect, useState } from 'react';
import { Alert, App, Button, InputNumber } from 'antd';
import { useApi } from '../hooks';
import { useAppearance } from '../appearance';
import { api } from '../services/api';
import { isFontScale } from '../services/appearance';
import { ErrorState, LoadingState } from './common';

export default function AppearanceSettings() {
  const request = useApi('/access/appearance');
  const { setAppearance } = useAppearance();
  const { message } = App.useApp();
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!request.data?.appearance) return;
    setSaved(request.data.appearance);
    setDraft(request.data.appearance.fontScale);
    setError(null);
  }, [request.data]);
  const save = async event => {
    event.preventDefault();
    if (!saved || !isFontScale(draft) || saving) return;
    setSaving(true); setError(null);
    try {
      const result = await api('/access/appearance', { method: 'PATCH',
        body: { fontScale: draft, expectedVersion: saved.version } });
      setSaved(result.appearance); setDraft(result.appearance.fontScale);
      setAppearance(result.appearance);
      message.success('Tamaño de letra guardado para todo el portal.');
    } catch (caught) { setError(caught); } finally { setSaving(false); }
  };
  return <section className="evaluation-card appearance-settings" aria-labelledby="appearance-heading">
    <h2 id="appearance-heading">Tamaño de letra</h2>
    <p id="appearance-help">Se aplica a todos los usuarios. 1 = tamaño actual; 2 = doble. Puedes usar valores intermedios en pasos de 0.1. Los demás usuarios verán el cambio al recargar.</p>
    {request.error ? <ErrorState error={request.error} retry={request.reload} /> : !saved ? <LoadingState /> : <form onSubmit={save}>
      <label htmlFor="portal-font-scale">Multiplicador de letra</label>
      <div className="appearance-actions">
        <InputNumber id="portal-font-scale" aria-describedby="appearance-help" min={1} max={2} step={0.1}
          value={draft} disabled={saving} onChange={setDraft} />
        <Button htmlType="submit" type="primary" loading={saving} disabled={!isFontScale(draft) || draft === saved.fontScale}>Guardar</Button>
        <Button disabled={saving || draft === 1} onClick={() => setDraft(1)}>Restablecer a 1</Button>
      </div>
      {!isFontScale(draft) && <p className="appearance-validation" role="alert">Ingresa un valor de 1 a 2 en pasos de 0.1.</p>}
      {error && <Alert type="error" showIcon message={error.message} action={error.status === 409 ? <Button onClick={request.reload}>Cargar valor vigente</Button> : undefined} />}
    </form>}
  </section>;
}
