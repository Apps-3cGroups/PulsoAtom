import { useEffect, useState } from 'react';
import { App, Alert, Button, Form, Input, Radio, Select, Switch, Table, Tag, Tooltip } from 'antd';
import { PlayCircleOutlined, ClockCircleOutlined, DatabaseOutlined, ExperimentOutlined, ScheduleOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useApi, usePortal } from '../hooks';
import { api } from '../services/api';
import { PageHeading, LoadingState, ErrorState, EmptyState, dateText } from '../components/common';

export default function Evaluations() {
  const request = useApi('/evaluations');
  const { user } = usePortal();
  const navigate = useNavigate();
  const [scope, setScope] = useState('new');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const { message } = App.useApp();
  useEffect(() => { if (request.data?.jobs.some(job => job.status === 'running')) { const timer = setInterval(request.reload, 3000); return () => clearInterval(timer); } }, [request.data?.jobs, request.reload]);
  if (request.error) return <ErrorState error={request.error} retry={request.reload} />;
  if (request.loading || !request.data) return <LoadingState />;
  const data = request.data;
  const ready = data.mode === 'real' && data.status.ready;
  const start = async () => {
    setRunning(true); setError(null);
    try { const result = await api('/evaluations', { method: 'POST', body: { scope, ...(scope === 'period' ? { from, to } : {}), max: 20 } }); message.success(`Ejecución ${result.job.id.slice(0, 8)} iniciada para ${result.job.total} conversaciones.`); request.reload(); }
    catch (caught) { setError(caught); } finally { setRunning(false); }
  };
  const atomDescription = data.mode === 'demo'
    ? 'Conexión verificada; activa el modo real para mostrar el histórico de Atom.'
    : data.status.atomConfigured
      ? 'Histórico conectado: conversaciones, mensajes, asesores y países.'
      : 'Pendiente de conexión y estructura de las tablas.';
  return <div><PageHeading eyebrow="MOTOR DE REVISIÓN" title="Evaluación de conversaciones" description="A demanda o cada día. Un mismo checklist, resultados con evidencia." actions={<Tag className={ready ? 'neutral-tag' : 'pending-tag'}>{ready ? 'Motor configurado' : 'Pendiente de configuración'}</Tag>} />{!ready && <Alert className="integration-alert" type="info" showIcon message="La evaluación real todavía no está disponible" description={data.status.blockers.join(' ')} />}{error && <Alert type="error" showIcon message={error.message} />}<div className="evaluation-cards"><section className="evaluation-card"><div className="evaluation-icon"><PlayCircleOutlined /></div><h2>A demanda</h2><p>Inicia una revisión cuando lo necesites y consulta su avance desde el portal.</p><div className="evaluation-checklist"><span><b>{data.activeCount}</b> variables habilitadas</span><Button type="link" onClick={() => navigate('/catalogo')}>Ver checklist <ArrowRightOutlined /></Button></div><Radio.Group value={scope} onChange={e => setScope(e.target.value)} className="scope-radio"><Radio value="new"><b>Nuevas conversaciones pendientes</b><span>Solo conversaciones que aún no tienen evaluación.</span></Radio><Radio value="period"><b>Seleccionar un período</b><span>Revisar las conversaciones de un rango de fechas.</span></Radio></Radio.Group>{scope === 'period' && <div className="form-two-columns evaluation-dates"><label>Desde<Input type="date" aria-label="Evaluar desde" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Hasta<Input type="date" aria-label="Evaluar hasta" value={to} onChange={e => setTo(e.target.value)} /></label></div>}<div className="evaluation-card-bottom"><Tooltip title={user.role !== 'admin' ? 'Solo un administrador puede iniciar evaluaciones.' : !ready ? 'Configura Atom, Pulso y OpenAI para iniciar.' : undefined}><span><Button type="primary" block icon={<PlayCircleOutlined />} loading={running} disabled={!ready || user.role !== 'admin' || (scope === 'period' && (!from || !to || from > to)) || data.jobs.some(job => job.status === 'running')} onClick={start}>Evaluar hasta 20 conversaciones</Button></span></Tooltip><p>Consultar un resultado guardado no vuelve a ejecutar la IA.</p></div></section><ScheduleCard data={data} isAdmin={user.role === 'admin'} onSaved={request.reload} /></div><section className="integration-panel"><div className="section-heading"><h2>Preparación del motor</h2><span className="muted small">Estado de la integración</span></div><div className="integration-grid"><Integration icon={<DatabaseOutlined />} title="Conversaciones de Atom" text={atomDescription} /><Integration icon={<ExperimentOutlined />} title="Evaluación con IA" text={data.status.aiConfigured ? 'Configuración de OpenAI recibida.' : 'Pendiente de configurar OpenAI.'} /><Integration icon={<ScheduleOutlined />} title="Procesamiento de lotes" text="Lotes a demanda de hasta 20 conversaciones; horario diario pendiente de habilitar." /></div></section><section className="table-panel jobs-panel"><div className="table-panel-head"><h2>Historial de ejecuciones</h2><span className="muted small">{data.jobs.length} ejecuciones</span></div><Table rowKey="id" dataSource={[...data.jobs].reverse()} columns={[{ title: 'Ejecución', dataIndex: 'id', render: value => value.slice(0, 8) }, { title: 'Estado', dataIndex: 'status' }, { title: 'Completadas', render: (_, job) => `${job.completed}/${job.total}` }, { title: 'Errores', dataIndex: 'failed' }, { title: 'Creada', dataIndex: 'createdAt', render: value => dateText(value) }]} pagination={{ pageSize: 10 }} locale={{ emptyText: <EmptyState title="Todavía no hay ejecuciones" description="Cuando inicies una evaluación, verás aquí su progreso y resultado." /> }} /></section></div>;
}
function ScheduleCard({ data, isAdmin, onSaved }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const { message } = App.useApp();
  const save = async values => {
    setSaving(true); setError(null);
    try { await api('/evaluations/settings', { method: 'PATCH', body: { ...values, dailyEnabled: false, expectedVersion: data.settings.version } }); message.success(`Horario guardado${data.mode === 'demo' ? ' en la demostración' : ''}. La programación sigue inactiva.`); onSaved(); }
    catch (error) { setError(error); } finally { setSaving(false); }
  };
  return <section className="evaluation-card"><div className="evaluation-icon"><ClockCircleOutlined /></div><h2>Evaluación diaria</h2><p>Procesa las nuevas conversaciones cada día, después de que se complete su carga.</p><div className="schedule-toggle"><div><b>Programación diaria</b><span>Inactiva hasta completar la integración</span></div><Switch checked={false} disabled aria-label="Programación diaria pendiente de integración" /></div>{error && <Alert type="error" showIcon message={error.message} />}<Form form={form} layout="vertical" onFinish={save} initialValues={{ dailyTime: data.settings.dailyTime, timezone: data.settings.timezone }} disabled={!isAdmin}><div className="form-two-columns"><Form.Item name="dailyTime" label="Hora de inicio" rules={[{ required: true, pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: 'Selecciona una hora válida.' }]}><Input type="time" aria-label="Hora de evaluación diaria" /></Form.Item><Form.Item name="timezone" label="Zona horaria" rules={[{ required: true }]}><Select aria-label="Zona horaria de evaluación" options={['America/Tegucigalpa', 'America/Mexico_City', 'America/Guatemala', 'America/Costa_Rica', 'UTC'].map(value => ({ value, label: value.replace('America/', '').replaceAll('_', ' ') }))} /></Form.Item></div><div className="schedule-hint"><ClockCircleOutlined /><span>El horario se conserva como configuración. Guardarlo no activa la ejecución automática.</span></div><div className="evaluation-card-bottom">{isAdmin ? <Button htmlType="submit" block loading={saving}>Guardar horario</Button> : <Tag className="neutral-tag">Solo un administrador puede cambiar el horario</Tag>}<p>Las nuevas evaluaciones utilizarán el checklist habilitado.</p></div></Form></section>;
}
function Integration({ icon, title, text }) { return <div className="integration-item"><span className="integration-item-icon">{icon}</span><div><h3>{title}</h3><p>{text}</p><span className="small muted">{title === 'Conversaciones de Atom' && text.startsWith('Histórico conectado') ? 'Conectado' : 'Pendiente'}</span></div></div>; }
