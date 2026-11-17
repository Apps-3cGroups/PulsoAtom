import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, App, Button, Drawer, Input, InputNumber, Space, Switch, Table, Tabs, Tag } from 'antd';
import Select from '../components/Select';
import { ArrowLeftOutlined, SaveOutlined, ReloadOutlined, PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { api } from '../services/api';
import { PageHeading, LoadingState, ErrorState, dateText } from '../components/common';
import LocalModelConfiguration from '../components/LocalModelConfiguration';
import ChecklistPrompts, { resolvedItemPrompts } from '../components/ChecklistPrompts';
import { jobStatus } from '../components/ModelControls';
import { automationCountryRows } from '../services/automationCountries';
import { sameEvaluationConfiguration as same } from '../services/evaluationConfiguration';
import './evaluation-configuration.css';

const modelNames = { 'clef-local': 'Clef', 'gemma-local': 'Gemma' };
const models = Object.keys(modelNames);
const modes = [{ value: 'parallel', label: 'Paralelo' }, { value: 'model-first', label: 'Secuencial por lote' }, { value: 'conversation-first', label: 'Secuencial por conversación' }];
const keepPolling = () => true;

export default function EvaluationConfiguration() {
  const request = useApi('/evaluations/settings');
  const history = useApi('/evaluations/settings/history');
  const [monitorDate, setMonitorDate] = useState('');
  const monitor = useApi(`/evaluations/automation${monitorDate ? `?activityDate=${monitorDate}` : ''}`, { pollIntervalMs: 10000, pollWhile: keepPolling });
  const { bootstrap } = usePortal();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [saved, setSaved] = useState(null), [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [unknown, setUnknown] = useState(false);
  const [preview, setPreview] = useState(null), [countrySearch, setCountrySearch] = useState('');
  const dirty = !!saved && !same(draft, saved.automation);
  useEffect(() => {
    if (!request.data || busy || (saved && request.data.settings.version < saved.settings.version)) return;
    if (!saved || !dirty) { setSaved(request.data); setDraft(structuredClone(request.data.automation)); }
  }, [request.data, busy, saved, dirty]);
  const change = (path, value) => setDraft(previous => {
    const next = structuredClone(previous); let target = next;
    for (const key of path.slice(0, -1)) target = target[key];
    target[path.at(-1)] = value; return next;
  });
  const adopt = result => {
    const merged = { ...saved, ...result };
    setSaved(merged); setDraft(structuredClone(result.automation)); setUnknown(false); setError(null);
    request.reload(); history.reload(); monitor.reload();
  };
  const mutate = async (path, body, method = 'POST') => {
    setBusy(true); setError(null);
    try { const result = await api(path, { method, body, timeoutMs: 30000 }); adopt(result); message.success('Configuración guardada.'); }
    catch (e) { setError(e); if (['NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE'].includes(e.code)) setUnknown(true); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true);
    try {
      const result = await api('/evaluations/settings', { timeoutMs: 30000 });
      setUnknown(false);
      if (same(result.automation, draft)) { adopt(result); message.success('Guardado confirmado en el servidor.'); }
      else { setSaved(result); setError({ message: 'El servidor tiene otra configuración. Conservamos tu borrador; revisa los cambios antes de guardar.' }); }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const showPreview = async () => {
    setBusy(true); setError(null);
    try { setPreview(await api('/evaluations/settings/preview', { method: 'POST', body: { automation: draft } })); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const resumeJob = async id => {
    setBusy(true); setError(null);
    try { await api(`/evaluations/${id}/resume`, { method: 'POST', body: {} }); monitor.reload(); message.success('Pendientes en cola para reanudar.'); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (request.error && !saved) return <ErrorState error={request.error} retry={request.reload} />;
  if (!draft) return <LoadingState />;
  const controlsDisabled = busy || unknown;
  const runControl = country => mutate('/evaluations/automation/control', { expectedVersion: saved.settings.version,
    action: (country ? saved.automation.countries.find(c => c.code === country)?.paused : saved.automation.paused) ? 'resume' : 'pause', ...(country ? { country } : {}) });
  const countryRows = automationCountryRows(draft.countries, saved.countries, countrySearch);
  const field = (label, content, hint) => <label className="automation-field"><span>{label}</span>{content}{hint && <small>{hint}</small>}</label>;
  const integer = (path, label, min, max, suffix) => field(suffix ? `${label} (${suffix})` : label, <InputNumber aria-label={label} min={min} max={max} precision={0} value={path.reduce((o, k) => o[k], draft)} onChange={value => change(path, value)} disabled={controlsDisabled} />);
  return <div className="automation-page">
    <PageHeading eyebrow="ADMINISTRACIÓN" title="Configuración de evaluaciones" description="Países, prompts y ejecución automática de Clef y Gemma." actions={<Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/evaluaciones')}>Evaluaciones</Button>} />
    {error && <Alert showIcon type="error" message={error.message} />}
    {request.error && saved && <Alert showIcon type="warning" message="No se pudo actualizar la configuración." action={<Button onClick={request.reload}>Reintentar</Button>} />}
    {unknown && <Alert type="warning" showIcon message="El guardado está por confirmar" description="Tu borrador permanece aquí. Comprueba el estado antes de volver a guardar." action={<Button loading={busy} onClick={verify}>Comprobar guardado</Button>} />}
    {!saved.configured && <Alert type="info" showIcon message="Configuración inicial" description="Se conservaron los valores existentes. Al guardar, el nuevo proceso automático reemplazará la programación diaria anterior. Las recuperaciones extraordinarias conservarán sus trabajos." />}
    {bootstrap.mode === 'demo' && <Alert type="info" showIcon message="Demostración" description="Puedes guardar y revisar la configuración. Aquí no se ejecutan modelos ni cargas reales." />}
    <div className="automation-toolbar">
      <Space><Tag color={saved.automation.enabled && !saved.automation.paused ? 'green' : 'default'}>{saved.automation.enabled ? saved.automation.paused ? 'Pausada' : 'Activada' : 'Desactivada'}</Tag><span>Versión {saved.settings.version}</span>{dirty && <Tag color="orange">Cambios sin guardar</Tag>}</Space>
      <Space wrap>
        <Button disabled={controlsDisabled || !saved.configured || !saved.automation.enabled || dirty} icon={saved.automation.paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />} onClick={() => runControl()}>{saved.automation.paused ? 'Reanudar' : 'Pausar'}</Button>
        <Button disabled={controlsDisabled || !dirty} onClick={() => { setDraft(structuredClone(saved.automation)); setError(null); }}>Descartar cambios</Button>
        <Button type="primary" icon={<SaveOutlined />} loading={busy} disabled={unknown || (!dirty && saved.configured)} onClick={() => mutate('/evaluations/settings', { expectedVersion: saved.settings.version, automation: draft }, 'PATCH')}>Guardar configuración</Button>
      </Space>
    </div>
    <Tabs items={[
      { key: 'countries', label: 'Países y selección', children: <section className="automation-panel">
        <div className="automation-grid">
          {field('Evaluación automática', <Switch aria-label="Evaluación automática" checked={draft.enabled} disabled={controlsDisabled} onChange={value => change(['enabled'], value)} />, 'Los cupos no limitan las evaluaciones manuales.')}
          {field('Selección de conversaciones', <Select aria-label="Selección de conversaciones" value={draft.selection} disabled={controlsDisabled} onChange={value => change(['selection'], value)} options={[{ value: 'random', label: 'Aleatoria reproducible' }, { value: 'newest', label: 'Actividad más reciente' }, { value: 'oldest', label: 'Actividad más antigua' }]} />)}
          {field('Incluir conversaciones abiertas', <Switch aria-label="Incluir conversaciones abiertas" checked={draft.includeOpen} disabled={controlsDisabled} onChange={value => change(['includeOpen'], value)} />, 'Sus resultados se identifican como provisionales.')}
        </div>
        <p>Se muestran los países con conversaciones registradas en Atom. Se revisa la actividad del día anterior entre las conversaciones disponibles. Ambos modelos comparten la selección; cada conversación consume un solo cupo.</p>
        <Input.Search aria-label="Buscar país" placeholder="Buscar país" value={countrySearch} onChange={e => setCountrySearch(e.target.value)} className="automation-country-search" allowClear />
        <Table rowKey="code" dataSource={countryRows} pagination={{ pageSize: 12, hideOnSinglePage: true }} scroll={{ x: 650 }} locale={{ emptyText: countrySearch.trim() ? 'No hay países que coincidan con la búsqueda.' : 'No hay países con conversaciones registradas en Atom.' }} columns={[
          { title: 'País', render: (_, c) => <><strong>{c.name}</strong> <span className="muted">{c.code}</span></> },
          { title: 'Habilitado', render: (_, c) => <Switch aria-label={`Habilitar ${c.name}`} checked={c.enabled} disabled={controlsDisabled} onChange={value => change(['countries', c.index, 'enabled'], value)} /> },
          { title: 'Cupo diario', render: (_, c) => <InputNumber aria-label={`Cupo de ${c.name}`} value={c.dailyLimit} min={1} max={100000} precision={0} disabled={controlsDisabled} onChange={value => change(['countries', c.index, 'dailyLimit'], value)} /> },
          { title: 'Cupo utilizado', render: (_, c) => monitor.data?.countries.find(row => row.code === c.code)?.selected ?? '—' },
          { title: 'Procesamiento', render: (_, c) => <Tag color={!c.enabled || c.paused ? 'default' : 'green'}>{!c.enabled ? 'Deshabilitado' : c.paused ? 'Pausado' : 'Habilitado'}</Tag> },
          { title: 'Acción', render: (_, c) => <Button disabled={controlsDisabled || dirty || !saved.configured || !c.enabled} onClick={() => runControl(c.code)}>{c.paused ? 'Reanudar país' : 'Pausar país'}</Button> },
        ]} />
        <p className="muted">Los países nuevos aparecen deshabilitados. Reducir un cupo conserva lo seleccionado. Una pausa deja terminar las solicitudes en curso.</p>
      </section> },
      { key: 'prompts', label: 'Prompts', children: <section className="automation-panel">
        <ChecklistPrompts checklist={saved.checklist} prompts={draft.prompts} disabled={controlsDisabled} onChange={value => change(['prompts', 'byItem'], value)} />
        <h2>Instrucciones generales</h2>
        <div className="automation-toolbar">{field('Modo de prompts', <Select aria-label="Modo de prompts" value={draft.prompts.mode} disabled={controlsDisabled} onChange={value => change(['prompts', 'mode'], value)} options={[{ value: 'shared', label: 'Compartido por ambos modelos' }, { value: 'per-model', label: 'Específico por modelo' }]} />)}<Button disabled={controlsDisabled} onClick={showPreview}>Ver prompt efectivo</Button></div>
        <p>Estas instrucciones se aplican a todos los países. Las reglas de formato, catálogo y evidencia se añaden automáticamente. Los lotes iniciados conservan su versión.</p>
        {draft.prompts.mode === 'shared' ? field('Prompt compartido', <Input.TextArea aria-label="Prompt compartido" value={draft.prompts.shared} rows={14} maxLength={30000} showCount disabled={controlsDisabled} onChange={e => change(['prompts', 'shared'], e.target.value)} />)
          : <div className="automation-prompt-grid">{models.map(id => <div key={id}>{field(`Prompt de ${modelNames[id]}`, <Input.TextArea aria-label={`Prompt de ${modelNames[id]}`} rows={16} maxLength={30000} showCount value={draft.prompts.byModel[id]} disabled={controlsDisabled} onChange={e => change(['prompts', 'byModel', id], e.target.value)} />)}</div>)}</div>}
      </section> },
      { key: 'execution', label: 'Ejecución', children: <section className="automation-panel"><div className="automation-grid">
        {field('Modo de ejecución', <Select aria-label="Modo de ejecución" options={modes} value={draft.executionOrder} disabled={controlsDisabled} onChange={value => change(['executionOrder'], value)} />)}
        {draft.executionOrder !== 'parallel' && field('Orden de los modelos', <Select aria-label="Orden de los modelos" value={draft.modelOrder[0]} disabled={controlsDisabled} onChange={value => change(['modelOrder'], [value, ...models.filter(id => id !== value)])} options={models.map(id => ({ value: id, label: `${modelNames[id]} primero; ${modelNames[models.find(other => other !== id)]} después` }))} />)}
        {integer(['blockSize'], 'Conversaciones por bloque', 1, 100)}
        {models.map(id => <div key={id}>{integer(['concurrency', id], `Solicitudes simultáneas de ${modelNames[id]}`, 1, 3)}{integer(['timeoutMs', id], `Tiempo máximo de ${modelNames[id]}`, 1000, 600000, 'ms')}</div>)}
      </div><Alert type="info" showIcon message="Si un modelo falla, el otro continúa" description="Las revisiones incompletas quedan identificadas. El orden se conserva por lote o por conversación, incluso al reanudar. En paralelo, cada modelo tiene su propio límite de concurrencia." /></section> },
      { key: 'operation', label: 'Operación', children: <section className="automation-panel"><div className="automation-grid">
        {field('Inicio de detección', <Input type="time" aria-label="Inicio de detección" value={draft.time} disabled={controlsDisabled} onChange={e => change(['time'], e.target.value)} />, 'Las cargas de Atom siguen iniciando a las 00:01.')}
        {field('Zona horaria', <Select aria-label="Zona horaria" value={draft.timezone} disabled={controlsDisabled} onChange={value => change(['timezone'], value)} options={[...new Set([draft.timezone, 'America/Tegucigalpa', 'America/Panama', 'America/Mexico_City', 'UTC'])].map(value => ({ value, label: value }))} />)}
        {integer(['pollSeconds'], 'Frecuencia de detección', 10, 3600, 's')}
        {integer(['retries'], 'Reintentos adicionales', 0, 5)}
        {draft.retryDelaysSeconds.map((_, index) => <div key={index}>{integer(['retryDelaysSeconds', index], `Espera de reintento ${index + 1}`, 1, 86400, 's')}</div>)}
        {integer(['missingLoadMinutes'], 'Avisar si no hay carga después de', 1, 1440, 'min')}
      </div><p>La última espera se reutiliza si configuras más reintentos. Solo se recupera trabajo seleccionado; el excedente fuera de muestra no se acumula. Los avisos se muestran en el monitor.</p></section> },
      { key: 'monitor', label: 'Monitor', children: <section className="automation-panel"><div className="automation-toolbar"><div><label className="automation-field"><span>Consultar fecha de actividad</span><Input type="date" aria-label="Consultar fecha de actividad" value={monitorDate || monitor.data?.activityDate || ''} onChange={e => setMonitorDate(e.target.value)} /></label><h2>Actividad evaluada: {monitor.data?.activityDate || '—'}</h2><p>Última detección correcta: {dateText(monitor.data?.lastSuccessfulDetectionAt)}</p></div><Button icon={<ReloadOutlined />} loading={monitor.loading} onClick={monitor.reload}>Actualizar</Button></div>
        {monitor.error && <Alert type="warning" showIcon message={monitor.error.message} />}
        <Table rowKey="code" dataSource={monitor.data?.countries || []} scroll={{ x: 850 }} pagination={{ pageSize: 12 }} columns={[
          { title: 'País', dataIndex: 'name' }, { title: 'Disponibles', dataIndex: 'available', render: v => v ?? 'Sin detección' }, { title: 'Seleccionadas / cupo', render: (_, c) => `${c.selected} / ${c.dailyLimit}` },
          ...models.map(id => ({ title: `${modelNames[id]} completadas / pendientes`, render: (_, c) => `${c.models[id]?.completed || 0} / ${c.models[id]?.pending || 0}` })),
          { title: 'Fuera de muestra', dataIndex: 'outsideSample', render: v => v ?? '—' },
        ]} />
        <h3>Alertas</h3><Table rowKey="id" size="small" dataSource={monitor.data?.alerts || []} pagination={{ pageSize: 5 }} locale={{ emptyText: 'Sin alertas registradas.' }} columns={[{ title: 'Estado', render: (_, a) => <Tag color={a.resolvedAt ? 'green' : 'orange'}>{a.resolvedAt ? 'Resuelta' : 'Pendiente'}</Tag> }, { title: 'País', dataIndex: 'country' }, { title: 'Aviso', dataIndex: 'message' }, { title: 'Fecha', dataIndex: 'createdAt', render: dateText }]} />
        <h3>Ejecuciones</h3><Table expandable={{ expandedRowRender: j => <div><p>Versión de prompts: {j.promptVersion}. {j.nextAttemptAt ? `Próximo reintento: ${dateText(j.nextAttemptAt)}` : j.status === 'paused' ? 'En espera de habilitación o reanudación global / del país.' : ''}</p>{j.models?.map(p => <p key={p.id}>{p.label}: {p.model}<br /><small>Huella del prompt: {j.promptHashes?.[p.id] || 'Configuración anterior'}</small></p>)}{j.errors?.map((e, i) => <p key={i}>{modelNames[e.profileId] || e.profileId} · {e.conversationId}: {e.message}</p>)}</div> }} rowKey="id" size="small" dataSource={monitor.data?.jobs || []} scroll={{ x: 750 }} pagination={{ pageSize: 5 }} columns={[{ title: 'ID', dataIndex: 'id', render: id => id.slice(0, 8) }, { title: 'Día de actividad', dataIndex: 'activityDate' }, { title: 'Estado', dataIndex: 'status', render: jobStatus }, { title: 'Modo', dataIndex: 'executionOrder', render: value => modes.find(m => m.value === value)?.label }, { title: 'Configuración', dataIndex: 'configurationVersion' }, { title: 'Revisiones', render: (_, j) => `${j.completed} / ${j.total}` }, { title: 'Acción', render: (_, j) => ['partial', 'failed', 'interrupted'].includes(j.status) ? <Button disabled={controlsDisabled} onClick={() => resumeJob(j.id)}>Reanudar pendientes</Button> : null }]} />
      </section> },
      { key: 'history', label: 'Historial', children: <section className="automation-panel"><p>Restaurar crea una versión nueva. Las ejecuciones anteriores conservan su configuración.</p>{history.error && <ErrorState error={history.error} retry={history.reload} />}<Table rowKey="version" dataSource={history.data?.items || []} pagination={{ pageSize: 10 }} scroll={{ x: 700 }} columns={[
        { title: 'Versión', dataIndex: 'version' }, { title: 'Fecha', dataIndex: 'createdAt', render: dateText }, { title: 'Autor', dataIndex: 'author' },
        { title: 'Acciones', render: (_, h) => <Space wrap><Button disabled={controlsDisabled || dirty} onClick={() => setPreview({ profiles: models.map(id => ({ id, label: modelNames[id], itemPrompts: resolvedItemPrompts(h.configuration.prompts, id), text: h.configuration.prompts.mode === 'shared' ? h.configuration.prompts.shared : h.configuration.prompts.byModel[id] })) })}>Ver prompts</Button><Button disabled={controlsDisabled || dirty} onClick={() => mutate('/evaluations/settings', { expectedVersion: saved.settings.version, restoreVersion: h.version, restoreScope: 'prompts' }, 'PATCH')}>Restaurar prompts</Button><Button disabled={controlsDisabled || dirty} onClick={() => mutate('/evaluations/settings', { expectedVersion: saved.settings.version, restoreVersion: h.version, restoreScope: 'all' }, 'PATCH')}>Restaurar configuración</Button></Space> },
      ]} /></section> },
      { key: 'connections', label: 'Conexión de modelos', children: <LocalModelConfiguration demo={bootstrap.mode === 'demo'} isAdmin running={monitor.data?.jobs.some(j => j.status === 'running')} onSaved={() => { request.reload(); monitor.reload(); }} /> },
    ]} />
    <Drawer title="Instrucciones del modelo" open={!!preview} onClose={() => setPreview(null)} width="min(850px, 100vw)"><Tabs items={(preview?.profiles || []).map(p => ({ key: p.id, label: p.label, children: <><h3>Instrucciones generales</h3><pre className="automation-prompt-preview">{p.text}</pre>{Object.entries(p.itemPrompts || {}).map(([id, text]) => <section key={id}><h3>{saved.checklist?.find(item => item.id === id)?.name || id} · {id}</h3><pre className="automation-prompt-preview">{text}</pre></section>)}</> }))} /></Drawer>
  </div>;
}
