import { defaultDateRange } from '../services/dateRange';
import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Radio, Select, Table, Tag } from 'antd';
import { SwapOutlined, SafetyCertificateOutlined, HistoryOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useApi, useDebounced, usePortal } from '../hooks';
import { api, queryString } from '../services/api';
import { ErrorState, LoadingState, tableLoading } from './common';
import LocalModelConfiguration from './LocalModelConfiguration';
import { executableProfiles, policySelection } from '../services/localModels';

export const jobStatus = status => ({ running: 'En curso', pending: 'Pendiente', completed: 'Completada', partial: 'Parcial', failed: 'Fallida', interrupted: 'Interrumpida' }[status] || status);
export function ModelControls({ onSaved, running }) {
  const request = useApi('/models');
  const { user, bootstrap } = usePortal();
  const refresh = () => { request.reload(); onSaved(); };
  const data = request.data && { ...request.data, profiles: executableProfiles(request.data.profiles, bootstrap.mode === 'demo') };
  return <><LocalModelConfiguration demo={bootstrap.mode === 'demo'} isAdmin={user.role === 'admin'} running={running} onSaved={refresh} />{request.error ? <ErrorState error={request.error} retry={request.reload} /> : !data ? <LoadingState /> : <div className="model-controls-grid"><PolicyCard key={`${data.policy.version}:${data.profiles.map(p => `${p.viewId || p.id}:${p.available}`).join(',')}`} data={data} isAdmin={user.role === 'admin'} onSaved={refresh} /><SampleCard key={data.profiles.map(p => `${p.viewId || p.id}:${p.available}`).join(',')} profiles={data.profiles} isAdmin={user.role === 'admin'} running={running} /></div>}</>;
}
function PolicyCard({ data, isAdmin, onSaved }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const selection = policySelection(data.policy, data.profiles);
  const primary = Form.useWatch('primaryId', form);
  const mode = Form.useWatch('mode', form) || selection.mode || 'single';
  const localProfiles = data.profiles.filter(p => !p.historical && p.provider === 'gateway');
  const options = data.profiles.filter(p => !p.historical).map(p => ({ value: p.id, label: `${p.label}${p.model ? ` · ${p.model}` : ''}${p.available ? '' : ' · Pendiente'}`, disabled: !p.available }));
  const save = async values => {
    setBusy(true); setError(null);
    try { await api('/models/policy', { method: 'PATCH', body: { ...values, mode, secondaryId: mode === 'dual' ? values.secondaryId : null, fallbackId: mode === 'single' ? values.fallbackId || null : null, expectedVersion: data.policy.version } }); message.success('Política guardada para las nuevas ejecuciones.'); onSaved(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return <section className="evaluation-card model-policy"><div className="evaluation-icon"><SafetyCertificateOutlined /></div><h2>Revisión y contingencia</h2><p>Dos revisiones independientes o un modelo con respaldo. Pulso conserva un único flag operativo y la respuesta de cada modelo.</p>{error && <Alert type="error" showIcon message={error.message} />}
    {selection.pending && <Alert type="warning" showIcon message="Política pendiente de configurar" description="Selecciona los modelos habilitados y guarda la política para las nuevas ejecuciones. La selección mostrada aún no está guardada." />}
    <Form form={form} layout="vertical" initialValues={{ mode: selection.mode || 'single', primaryId: selection.primaryId, secondaryId: selection.secondaryId, fallbackId: selection.fallbackId }} onFinish={save} disabled={!isAdmin || busy}>
      <Form.Item name="mode" label="Método de evaluación"><Radio.Group options={[{ value: 'single', label: 'Principal + respaldo' }, { value: 'dual', label: 'Doble revisión' }]} /></Form.Item>
      <Form.Item name="primaryId" label="Modelo principal" rules={[{ required: true, message: 'Selecciona un modelo habilitado.' }]}><Select aria-label="Modelo principal" placeholder="Seleccionar modelo habilitado" options={options} onChange={value => { if (form.getFieldValue('fallbackId') === value) form.setFieldValue('fallbackId', null); if (form.getFieldValue('secondaryId') === value) form.setFieldValue('secondaryId', null); }} /></Form.Item>
      {mode === 'dual' ? <><Form.Item name="secondaryId" label="Segundo modelo" rules={[{ required: true, message: 'Selecciona un segundo modelo habilitado.' }]}><Select aria-label="Segundo modelo" placeholder="Seleccionar segundo modelo" options={options.filter(p => p.value !== primary)} /></Form.Item><Alert type="info" showIcon message="Dos revisiones por conversación" description="Ambos modelos reciben el mismo contenido y checklist. Si uno falla técnicamente, el otro mantiene el resultado disponible; la comparación queda incompleta. Cada proveedor genera su propio consumo." /></> : <Form.Item name="fallbackId" label="Respaldo automático"><Select aria-label="Modelo de respaldo" allowClear placeholder="Sin respaldo configurado" options={options.filter(p => p.value !== primary)} /></Form.Item>}
      <div className="evaluation-card-bottom">{isAdmin && <Button htmlType="submit" loading={busy} block>Guardar política</Button>}<p>{mode === 'dual' ? 'Un reintento por modelo. Reanudar una revisión fallida conserva la respuesta del otro modelo.' : 'Un reintento y, si el fallo técnico persiste, el respaldo.'} Los resultados históricos permanecen asociados a su evaluación.</p></div>
    </Form>{localProfiles.length > 0 && <div className="local-model-note">Modelos locales {localProfiles.map(p => <Tag key={p.id} color={p.available ? 'green' : 'default'}>{p.label} · {p.available ? 'Habilitado' : p.configured ? 'Deshabilitado' : 'Sin configurar'}</Tag>)}<span>Las nuevas ejecuciones utilizan la política guardada.</span></div>}
  </section>;
}
function SampleCard({ profiles, isAdmin, running }) {
  const { bootstrap } = usePortal();
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [search, setSearch] = useState('');
  const selection = Form.useWatch('selection', form) || 'random';
  const country = Form.useWatch('country', form), from = Form.useWatch('from', form), to = Form.useWatch('to', form);
  const debounced = useDebounced(search);
  const candidates = useApi(selection === 'manual' ? `/comparison-candidates?${queryString({ q: debounced, country, from, to })}` : null);
  const key = useRef({ payload: null, id: null });
  const available = profiles.filter(p => p.available);
  const submit = async values => {
    const { selection, ...rest } = values;
    const body = { ...rest, max: selection === 'manual' ? values.conversationIds.length : values.max };
    for (const k of ['from', 'to', 'country']) if (!body[k]) delete body[k];
    if (selection !== 'manual') delete body.conversationIds;
    const payload = JSON.stringify(body);
    if (key.current.payload !== payload) key.current = { payload, id: crypto.randomUUID() };
    setBusy(true); setError(null);
    try { const result = await api('/comparisons', { method: 'POST', body: { ...body, idempotencyKey: key.current.id } }); navigate(`/comparacion?sample=${result.job.id}`); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return <section className="evaluation-card sample-card"><div className="evaluation-icon"><SwapOutlined /></div><h2>Comparar una muestra</h2><p>Las mismas conversaciones y el mismo checklist para todos los modelos. La operación conserva su resultado oficial.</p>
    {available.length < 2 && <Alert type="info" showIcon message="Hace falta un segundo modelo habilitado" description="Configura y habilita un segundo modelo para comparar. Puedes seguir consultando el histórico." />}{error && <Alert type="error" showIcon message={error.message} />}
    <Form form={form} layout="vertical" onFinish={submit} initialValues={{ name: 'Comparación de calidad', modelIds: available.slice(0, 2).map(p => p.id), selection: 'random', max: 10, ...defaultDateRange(bootstrap.dateRange.max, bootstrap.timezone) }} disabled={!isAdmin || busy}>
      <div className="form-two-columns"><Form.Item name="name" label="Nombre de la muestra" rules={[{ required: true, min: 3, max: 100 }]}><Input maxLength={100} /></Form.Item><Form.Item name="modelIds" label="Modelos · máximo 3" rules={[{ required: true, type: 'array', min: 2, max: 3, message: 'Selecciona dos o tres modelos.' }]}><Select aria-label="Modelos a comparar" mode="multiple" maxCount={3} options={profiles.filter(p => !p.historical).map(p => ({ value: p.id, label: `${p.label} · ${p.model || 'Pendiente'}`, disabled: !p.available }))} /></Form.Item></div>
      <div className="sample-filters"><Form.Item name="country" label="País"><Select aria-label="País de la muestra" allowClear placeholder="Todos los países" options={bootstrap.countries.map(c => ({ value: c.code, label: c.name }))} /></Form.Item><Form.Item name="from" label="Desde"><Input type="date" /></Form.Item><Form.Item name="to" label="Hasta" dependencies={['from']} rules={[({ getFieldValue }) => ({ validator(_, value) { return !value || !getFieldValue('from') || value >= getFieldValue('from') ? Promise.resolve() : Promise.reject(new Error('Revisa el período.')); } })]}><Input type="date" /></Form.Item></div>
      <Form.Item name="selection" label="Selección"><Radio.Group options={[{ label: 'Aleatoria', value: 'random' }, { label: 'Elegir conversaciones', value: 'manual' }]} /></Form.Item>
      {selection === 'random' ? <Form.Item name="max" label="Cantidad de conversaciones" rules={[{ required: true }]}><InputNumber min={1} max={20} /></Form.Item> : <Form.Item name="conversationIds" label="Conversaciones · máximo 20" rules={[{ required: true, type: 'array', min: 1, max: 20 }]}><Select aria-label="Conversaciones de la muestra" mode="multiple" maxCount={20} showSearch filterOption={false} onSearch={setSearch} loading={candidates.loading} options={(candidates.data?.items || []).map(c => ({ value: c.id, label: `${c.clientName} · ${c.country} · ${c.id}` }))} /></Form.Item>}
      {candidates.error && <Alert type="error" message={candidates.error.message} />}
      <div className="evaluation-card-bottom"><Button type="primary" htmlType="submit" block icon={<SwapOutlined />} loading={busy} disabled={!isAdmin || available.length < 2 || running}>Evaluar muestra</Button><p>{bootstrap.mode === 'demo' ? 'Resultados sintéticos identificados. No se contacta ningún proveedor.' : 'Esta acción ejecuta los modelos seleccionados. Consultar resultados guardados no consume IA.'}</p></div>
    </Form>
  </section>;
}
export function JobActions({ job, onSaved }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const { user } = usePortal();
  const request = useApi(open ? `/evaluations/${job.id}/attempts` : null);
  useEffect(() => { if (open && job.status === 'running') { const timer = setInterval(request.reload, 3000); return () => clearInterval(timer); } }, [open, job.status, request.reload]);
  const resume = async () => { setBusy(true); setError(null); try { await api(`/evaluations/${job.id}/resume`, { method: 'POST', body: {} }); onSaved(); } catch (e) { setError(e); } finally { setBusy(false); } };
  return <><Button type="text" icon={<HistoryOutlined />} onClick={() => setOpen(true)}>Detalle</Button><Drawer title="Ejecución y contingencia" open={open} onClose={() => setOpen(false)} width="min(660px, 100vw)">
    <p>{job.purpose === 'comparison' ? 'Comparación de modelos' : 'Evaluación operativa'} · {jobStatus(job.status)}</p>{job.fallback && <p>Respaldo configurado: {job.fallback.label} · {job.fallback.model}</p>}{error && <Alert type="error" message={error.message} />}
    {request.error ? <ErrorState error={request.error} retry={request.reload} /> : <Table rowKey="id" size="small" loading={tableLoading(request.loading)} dataSource={request.data?.attempts || []} columns={[{ title: 'Modelo', render: (_, a) => <div>{a.requestedModel}{a.actualModel && a.actualModel !== a.requestedModel && <small> → {a.actualModel}</small>}</div> }, { title: 'Estado', render: (_, a) => <div>{jobStatus(a.status)}{a.error && <small className="attempt-error">{a.error.message}</small>}</div> }, { title: 'Tiempo', render: (_, a) => a.durationMs == null ? '—' : `${(a.durationMs / 1000).toFixed(1)} s` }]} pagination={{ pageSize: 8 }} />}
    {user.role === 'admin' && job.modelProfiles && ['partial', 'failed', 'interrupted'].includes(job.status) && <Button icon={<ReloadOutlined />} loading={busy} onClick={resume}>Reanudar pendientes y fallidos</Button>}
    <p className="small muted">Los resultados completados se conservan. Cada reanudación registra nuevos intentos y verifica que el origen siga siendo el mismo.</p>
  </Drawer></>;
}
