import { defaultDateRange } from '../services/dateRange';
import { ModelControls, JobActions, jobStatus } from '../components/ModelControls';
import ScheduleCard from '../components/ScheduleCard';
import { useEffect, useRef, useState } from 'react';
import { App, Alert, Button, Input, Radio, Select, Table, Tabs, Tag, Tooltip } from 'antd';
import { PlayCircleOutlined, DatabaseOutlined, ExperimentOutlined, ScheduleOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi, usePortal } from '../hooks';
import { api } from '../services/api';
import { PageHeading, LoadingState, ErrorState, EmptyState, dateText } from '../components/common';

export default function Evaluations() {
  const request = useApi('/evaluations');
  const { user, bootstrap } = usePortal();
  const defaults = defaultDateRange(bootstrap.dateRange.max, bootstrap.timezone);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const section = params.get('seccion') === 'modelos' ? 'models' : 'operation';
  const requestKey = useRef({ body: null, id: null });
  const [scope, setScope] = useState('new');
  const [batchSize, setBatchSize] = useState(20);
  const [reviewMode, setReviewMode] = useState(null);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const { message } = App.useApp();
  const hasRunningJob = request.data?.jobs.some(job => job.status === 'running');
  useEffect(() => {
    if (request.data) setReviewMode(current => current ?? (request.data.localDualAvailable ? 'local-dual' : 'configured'));
  }, [request.data]);
  useEffect(() => {
    if (!hasRunningJob || request.loading || request.error) return;
    // Wait for the previous response before checking again; slow requests must finish.
    const timer = setTimeout(request.reload, 3000);
    return () => clearTimeout(timer);
  }, [hasRunningJob, request.loading, request.error, request.reload]);
  if (request.error && !request.data) return <ErrorState error={request.error} retry={request.reload} />;
  if (!request.data) return <LoadingState />;
  const data = request.data;
  const manualLimit = Math.min(100, Math.max(1, Number(data.limits?.manual) || 20));
  const max = Math.min(batchSize, manualLimit);
  const selectedReviewMode = reviewMode ?? (data.localDualAvailable ? 'local-dual' : 'configured');
  const ready = data.mode === 'real' && (selectedReviewMode === 'local-dual' ? data.localDualReady : data.status.ready);
  const isAdmin = user.role === 'admin';
  const disabled = !ready || !isAdmin || running || hasRunningJob || (scope === 'period' && (!from || !to || from > to));
  const start = async () => {
    if (disabled) return;
    setRunning(true); setError(null);
    const body = { scope, ...(scope === 'period' ? { from, to } : {}), max, reviewMode: selectedReviewMode };
    if (requestKey.current.body !== JSON.stringify(body)) requestKey.current = { body: JSON.stringify(body), id: crypto.randomUUID() };
    try { const result = await api('/evaluations', { method: 'POST', body: { ...body, idempotencyKey: requestKey.current.id } }); requestKey.current = { body: null, id: null }; message.success(`Ejecución ${result.job.id.slice(0, 8)} iniciada para ${(result.job.caseCount ?? result.job.total)} conversaciones.`); request.reload(); }
    catch (caught) { setError(caught); } finally { setRunning(false); }
  };
  const atomDescription = data.mode === 'demo'
    ? 'Datos sintéticos separados de Atom y de las evaluaciones reales.'
    : data.status.atomConfigured
      ? 'Histórico conectado: conversaciones, mensajes, asesores y países.'
      : 'Pendiente de conexión y estructura de las tablas.';
  return <div><PageHeading eyebrow="MOTOR DE REVISIÓN" title="Evaluación de conversaciones" description="A demanda o cada día. Un mismo checklist, resultados con evidencia." actions={<Tag className={ready ? 'neutral-tag' : 'pending-tag'}>{data.mode === 'demo' ? 'Demostración' : ready ? 'Motor configurado' : 'Pendiente de configuración'}</Tag>} />{!ready && data.mode !== 'demo' && <Alert className="integration-alert" type="info" showIcon message="La evaluación real todavía no está disponible" description={data.status.blockers.join(' ')} />}{request.error && <Alert type="warning" showIcon message="No pudimos actualizar la información. Conservamos tus cambios." description={request.error.message} action={<Button onClick={request.reload}>Reintentar</Button>} />}{error && <Alert type="error" showIcon message={error.message} />}<Tabs activeKey={section} onChange={key => setParams(key === 'models' ? { seccion: 'modelos' } : {})} items={[
    { key: 'operation', label: 'Evaluar conversaciones', children: <><div className="evaluation-cards"><section className="evaluation-card"><div className="evaluation-icon"><PlayCircleOutlined /></div><h2>A demanda</h2><p>Inicia una revisión cuando lo necesites y consulta su avance desde el portal.</p><div className="evaluation-checklist"><span><b>{data.activeCount}</b> variables habilitadas</span><Button type="link" onClick={() => navigate('/catalogo')}>Ver checklist <ArrowRightOutlined /></Button></div><Radio.Group value={scope} onChange={e => setScope(e.target.value)} className="scope-radio" disabled={running || !isAdmin}><Radio value="new"><b>Nuevas conversaciones pendientes</b><span>Conversaciones nuevas y, si está habilitado, aquellas cuyo contenido cambió.</span></Radio><Radio value="period"><b>Seleccionar un período</b><span>Revisar las conversaciones de un rango de fechas.</span></Radio></Radio.Group>{scope === 'period' && <div className="form-two-columns evaluation-dates"><label>Desde<Input type="date" aria-label="Evaluar desde" disabled={running || !isAdmin} value={from} onChange={e => setFrom(e.target.value)} /></label><label>Hasta<Input type="date" aria-label="Evaluar hasta" disabled={running || !isAdmin} value={to} onChange={e => setTo(e.target.value)} /></label></div>}<ManualBatchControls max={max} manualLimit={manualLimit} reviewMode={selectedReviewMode} localDualAvailable={data.localDualAvailable} disabled={running || !isAdmin} onMaxChange={setBatchSize} onReviewModeChange={setReviewMode} /><div className="evaluation-card-bottom"><Tooltip title={!isAdmin ? 'Solo un administrador puede iniciar evaluaciones.' : !ready ? 'Configura Atom, Pulso y los modelos seleccionados para iniciar.' : hasRunningJob ? 'Hay una ejecución en curso. Puedes preparar el siguiente lote.' : undefined}><span><Button type="primary" block icon={<PlayCircleOutlined />} loading={running} disabled={disabled} onClick={start}>Evaluar hasta {max} conversaciones</Button></span></Tooltip><p>Consultar un resultado guardado no vuelve a ejecutar la IA.</p></div></section><ScheduleCard data={data} isAdmin={user.role === 'admin'} onSaved={request.reload} /></div><JobHistory jobs={data.jobs.filter(job => job.purpose !== 'comparison')} reload={request.reload} /></> },
    { key: 'models', label: 'Herramientas internas', children: <><section className="internal-tools-intro"><div><span className="eyebrow">SOLO ADMINISTRACIÓN</span><h2>Configuración y calidad del motor</h2><p>Prueba modelos y configura el respaldo. El portal muestra un único resultado oficial con las revisiones humanas aplicadas.</p></div><Button onClick={() => navigate('/comparacion')}>Ver comparaciones guardadas <ArrowRightOutlined /></Button></section><ModelControls onSaved={request.reload} running={data.jobs.some(job => job.status === 'running')} /><section className="integration-panel"><div className="section-heading"><h2>Preparación del motor</h2><span className="muted small">Estado de la integración</span></div><div className="integration-grid"><Integration icon={<DatabaseOutlined />} title="Conversaciones de Atom" text={atomDescription} /><Integration icon={<ExperimentOutlined />} title="Evaluación con IA" state={data.mode === 'demo' ? 'Simulado' : data.status.aiConfigured ? 'Configurado' : 'Pendiente'} text={data.status.aiConfigured ? 'Hay modelos habilitados para evaluar.' : 'Pendiente de configurar modelos.'} /><Integration icon={<ScheduleOutlined />} title="Procesamiento de lotes" state="Disponible" text={`Lotes a demanda de hasta ${manualLimit} conversaciones y programación diaria de hasta 100 nuevas.`} /></div></section><JobHistory jobs={data.jobs.filter(job => job.purpose === 'comparison')} reload={request.reload} /></> },
  ]} /></div>;
}
function Integration({ icon, title, text, state }) { return <div className="integration-item"><span className="integration-item-icon">{icon}</span><div><h3>{title}</h3><p>{text}</p><span className="small muted">{state || (text.startsWith('Histórico conectado') ? 'Conectado' : text.startsWith('Datos sintéticos') ? 'Demostración' : 'Pendiente')}</span></div></div>; }

function JobHistory({ jobs, reload }) {
  return <section className="table-panel jobs-panel"><div className="table-panel-head"><h2>Historial de ejecuciones</h2><span className="muted small">{jobs.length} ejecuciones</span></div><Table rowKey="id" dataSource={[...jobs].reverse()} columns={[{ title: 'ID de ejecución', dataIndex: 'id', render: value => value.slice(0, 8) }, { title: 'Estado', dataIndex: 'status', render: jobStatus }, { title: 'Tipo', render: (_, job) => job.purpose === 'comparison' ? 'Comparación' : 'Operativa' }, { title: 'Modelos y avance', render: (_, job) => <JobModelProgress job={job} /> }, { title: 'Conversaciones', render: (_, job) => job.caseCount ?? job.total, align: 'center' }, { title: 'Revisiones completadas / total', align: 'center', render: (_, job) => `${job.completed} / ${job.total}` }, { title: 'Con error', dataIndex: 'failed', align: 'center' }, { title: 'Fecha de creación', dataIndex: 'createdAt', render: value => dateText(value) }, { title: 'Acciones', render: (_, job) => <JobActions job={job} onSaved={reload} /> }]} scroll={{ x: 1120 }} pagination={{ pageSize: 10 }} locale={{ emptyText: <EmptyState title="Todavía no hay ejecuciones" description="Cuando inicies una evaluación, verás aquí su progreso y resultado." /> }} /></section>;
}


export function ManualBatchControls({ max, manualLimit, reviewMode, localDualAvailable, disabled, onMaxChange, onReviewModeChange }) {
  const sizes = [...new Set([20, 50, 100, manualLimit].filter(value => value <= manualLimit))].sort((a, b) => a - b);
  const dual = reviewMode === 'local-dual';
  return <div className="manual-batch-controls">
    <div className="manual-batch-fields">
      <label htmlFor="manual-batch-size">Cantidad máxima<Select id="manual-batch-size" aria-label="Cantidad máxima de conversaciones" value={max} disabled={disabled} onChange={onMaxChange} options={sizes.map(value => ({ value, label: `${value} conversaciones` }))} /></label>
      <label htmlFor="manual-batch-models">Modelos para este lote<Select id="manual-batch-models" aria-label="Modelos para este lote" value={reviewMode} disabled={disabled} onChange={onReviewModeChange} options={[{ value: 'local-dual', label: 'Gemma y Clef', disabled: !localDualAvailable }, { value: 'configured', label: 'Modelos de la configuración' }]} /></label>
    </div>
    <div className="manual-batch-preview" aria-live="polite"><PlayCircleOutlined aria-hidden="true" /><div><strong>Hasta {max} conversaciones{dual && <> · hasta {max * 2} revisiones</>}</strong><span>{dual ? 'Primero Gemma y después Clef, sobre las mismas conversaciones.' : 'Se utilizará la política de modelos guardada.'}</span><small>Se evaluarán las conversaciones elegibles más recientes. Esta selección aplica solo a este lote.</small></div></div>
    {!localDualAvailable && <p className="manual-batch-unavailable">Gemma y Clef estarán disponibles cuando ambos modelos locales estén habilitados.</p>}
  </div>;
}

export function JobModelProgress({ job }) {
  const profiles = job.modelProfiles || [];
  const progress = job.modelProgress || [];
  if (!profiles.length && !progress.length) return <span className="muted">—</span>;
  const labels = profiles.length ? profiles.map(profile => profile.label || profile.id) : progress.map(model => model.label || model.profileId);
  return <div className="job-model-progress">
    <strong>{labels.join(job.executionOrder === 'model-first' ? ' → ' : ' + ')}</strong>
    {progress.map(model => {
      const processed = (model.completed || 0) + (model.partial || 0) + (model.failed || 0);
      const issues = (model.partial || 0) + (model.failed || 0);
      const status = model.total === 0 ? 'Sin conversaciones' : model.running > 0 ? 'En curso' : model.pending > 0 ? (processed ? 'Por continuar' : 'Pendiente') : issues ? 'Terminada con incidencias' : 'Terminada';
      return <div key={model.profileId} className="job-model-stage"><span>{model.label || model.profileId}</span><b title="Revisiones terminadas / total">{processed}/{model.total}</b><span>{status}</span>{issues > 0 && <Tooltip title={`${model.partial} parciales · ${model.failed} fallidas`}><Tag color="orange">{issues} con incidencias</Tag></Tooltip>}</div>;
    })}
  </div>;
}
