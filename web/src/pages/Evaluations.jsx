import { ModelControls, JobActions, jobStatus } from '../components/ModelControls';
import ScheduleCard from '../components/ScheduleCard';
import { useEffect, useRef, useState } from 'react';
import { App, Alert, Button, Input, Radio, Table, Tabs, Tag, Tooltip } from 'antd';
import { PlayCircleOutlined, DatabaseOutlined, ExperimentOutlined, ScheduleOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi, usePortal } from '../hooks';
import { api } from '../services/api';
import { PageHeading, LoadingState, ErrorState, EmptyState, dateText } from '../components/common';

export default function Evaluations() {
  const request = useApi('/evaluations');
  const { user } = usePortal();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const section = params.get('seccion') === 'modelos' ? 'models' : 'operation';
  const requestKey = useRef({ body: null, id: null });
  const [scope, setScope] = useState('new');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const { message } = App.useApp();
  const hasRunningJob = request.data?.jobs.some(job => job.status === 'running');
  useEffect(() => {
    if (!hasRunningJob || request.loading || request.error) return;
    // Wait for the previous response before checking again; slow requests must finish.
    const timer = setTimeout(request.reload, 3000);
    return () => clearTimeout(timer);
  }, [hasRunningJob, request.loading, request.error, request.reload]);
  if (request.error && !request.data) return <ErrorState error={request.error} retry={request.reload} />;
  if (!request.data) return <LoadingState />;
  const data = request.data;
  const ready = data.mode === 'real' && data.status.ready;
  const start = async () => {
    setRunning(true); setError(null);
    const body = { scope, ...(scope === 'period' ? { from, to } : {}), max: 20 };
    if (requestKey.current.body !== JSON.stringify(body)) requestKey.current = { body: JSON.stringify(body), id: crypto.randomUUID() };
    try { const result = await api('/evaluations', { method: 'POST', body: { ...body, idempotencyKey: requestKey.current.id } }); requestKey.current = { body: null, id: null }; message.success(`Ejecución ${result.job.id.slice(0, 8)} iniciada para ${result.job.total} conversaciones.`); request.reload(); }
    catch (caught) { setError(caught); } finally { setRunning(false); }
  };
  const atomDescription = data.mode === 'demo'
    ? 'Datos sintéticos separados de Atom y de las evaluaciones reales.'
    : data.status.atomConfigured
      ? 'Histórico conectado: conversaciones, mensajes, asesores y países.'
      : 'Pendiente de conexión y estructura de las tablas.';
  return <div><PageHeading eyebrow="MOTOR DE REVISIÓN" title="Evaluación de conversaciones" description="A demanda o cada día. Un mismo checklist, resultados con evidencia." actions={<Tag className={ready ? 'neutral-tag' : 'pending-tag'}>{data.mode === 'demo' ? 'Demostración' : ready ? 'Motor configurado' : 'Pendiente de configuración'}</Tag>} />{!ready && data.mode !== 'demo' && <Alert className="integration-alert" type="info" showIcon message="La evaluación real todavía no está disponible" description={data.status.blockers.join(' ')} />}{request.error && <Alert type="warning" showIcon message="No pudimos actualizar la información. Conservamos tus cambios." description={request.error.message} action={<Button onClick={request.reload}>Reintentar</Button>} />}{error && <Alert type="error" showIcon message={error.message} />}<Tabs activeKey={section} onChange={key => setParams(key === 'models' ? { seccion: 'modelos' } : {})} items={[
    { key: 'operation', label: 'Evaluar conversaciones', children: <><div className="evaluation-cards"><section className="evaluation-card"><div className="evaluation-icon"><PlayCircleOutlined /></div><h2>A demanda</h2><p>Inicia una revisión cuando lo necesites y consulta su avance desde el portal.</p><div className="evaluation-checklist"><span><b>{data.activeCount}</b> variables habilitadas</span><Button type="link" onClick={() => navigate('/catalogo')}>Ver checklist <ArrowRightOutlined /></Button></div><Radio.Group value={scope} onChange={e => setScope(e.target.value)} className="scope-radio"><Radio value="new"><b>Nuevas conversaciones pendientes</b><span>Solo conversaciones que aún no tienen evaluación.</span></Radio><Radio value="period"><b>Seleccionar un período</b><span>Revisar las conversaciones de un rango de fechas.</span></Radio></Radio.Group>{scope === 'period' && <div className="form-two-columns evaluation-dates"><label>Desde<Input type="date" aria-label="Evaluar desde" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Hasta<Input type="date" aria-label="Evaluar hasta" value={to} onChange={e => setTo(e.target.value)} /></label></div>}<div className="evaluation-card-bottom"><Tooltip title={user.role !== 'admin' ? 'Solo un administrador puede iniciar evaluaciones.' : !ready ? 'Configura Atom, Pulso y un modelo habilitado para iniciar.' : undefined}><span><Button type="primary" block icon={<PlayCircleOutlined />} loading={running} disabled={!ready || request.loading || user.role !== 'admin' || (scope === 'period' && (!from || !to || from > to)) || data.jobs.some(job => job.status === 'running')} onClick={start}>Evaluar hasta 20 conversaciones</Button></span></Tooltip><p>Consultar un resultado guardado no vuelve a ejecutar la IA.</p></div></section><ScheduleCard data={data} isAdmin={user.role === 'admin'} onSaved={request.reload} /></div><JobHistory jobs={data.jobs.filter(job => job.purpose !== 'comparison')} reload={request.reload} /></> },
    { key: 'models', label: 'Herramientas internas', children: <><section className="internal-tools-intro"><div><span className="eyebrow">SOLO ADMINISTRACIÓN</span><h2>Configuración y calidad del motor</h2><p>Prueba modelos y configura el respaldo. El portal muestra un único resultado oficial con las revisiones humanas aplicadas.</p></div><Button onClick={() => navigate('/comparacion')}>Ver comparaciones guardadas <ArrowRightOutlined /></Button></section><ModelControls onSaved={request.reload} running={data.jobs.some(job => job.status === 'running')} /><section className="integration-panel"><div className="section-heading"><h2>Preparación del motor</h2><span className="muted small">Estado de la integración</span></div><div className="integration-grid"><Integration icon={<DatabaseOutlined />} title="Conversaciones de Atom" text={atomDescription} /><Integration icon={<ExperimentOutlined />} title="Evaluación con IA" state={data.mode === 'demo' ? 'Simulado' : data.status.aiConfigured ? 'Configurado' : 'Pendiente'} text={data.status.aiConfigured ? 'Hay modelos habilitados para evaluar.' : 'Pendiente de configurar modelos.'} /><Integration icon={<ScheduleOutlined />} title="Procesamiento de lotes" state="Disponible" text="Lotes a demanda de hasta 20 conversaciones y programación diaria de hasta 100 nuevas." /></div></section><JobHistory jobs={data.jobs.filter(job => job.purpose === 'comparison')} reload={request.reload} /></> },
  ]} /></div>;
}
function Integration({ icon, title, text, state }) { return <div className="integration-item"><span className="integration-item-icon">{icon}</span><div><h3>{title}</h3><p>{text}</p><span className="small muted">{state || (text.startsWith('Histórico conectado') ? 'Conectado' : text.startsWith('Datos sintéticos') ? 'Demostración' : 'Pendiente')}</span></div></div>; }

function JobHistory({ jobs, reload }) {
  return <section className="table-panel jobs-panel"><div className="table-panel-head"><h2>Historial de ejecuciones</h2><span className="muted small">{jobs.length} ejecuciones</span></div><Table rowKey="id" dataSource={[...jobs].reverse()} columns={[{ title: 'Ejecución', dataIndex: 'id', render: value => value.slice(0, 8) }, { title: 'Estado', dataIndex: 'status', render: jobStatus }, { title: 'Tipo', render: (_, job) => job.purpose === 'comparison' ? 'Comparación' : 'Operativa' }, { title: 'Completadas', render: (_, job) => `${job.completed}/${job.total}` }, { title: 'Errores', dataIndex: 'failed' }, { title: 'Creada', dataIndex: 'createdAt', render: value => dateText(value) }, { title: '', render: (_, job) => <JobActions job={job} onSaved={reload} /> }]} pagination={{ pageSize: 10 }} locale={{ emptyText: <EmptyState title="Todavía no hay ejecuciones" description="Cuando inicies una evaluación, verás aquí su progreso y resultado." /> }} /></section>;
}
