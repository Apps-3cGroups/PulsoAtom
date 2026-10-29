import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Radio, Select } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, CheckCircleOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../hooks';
import { api } from '../services/api';
import { PageHeading, ErrorState, LoadingState, timeText } from '../components/common';

export default function Validation() {
  const { sampleId, conversationId } = useParams();
  const request = useApi(`/comparisons/${sampleId}/validation/${encodeURIComponent(conversationId)}`);
  const sample = useApi(`/comparisons/${sampleId}`);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [saved, setSaved] = useState(null);
  const [form] = Form.useForm();
  const values = Form.useWatch([], form);
  useEffect(() => { setSaved(null); setError(null); form.resetFields(); }, [sampleId, conversationId, form]);
  if (request.error) return <ErrorState error={request.error} retry={request.reload} />;
  if (!request.data || request.data.conversation.id !== conversationId || request.loading) return <LoadingState />;
  const data = request.data;
  const progress = data.variables.filter(v => values?.[v.id]?.outcome).length;
  const next = sample.data?.cases.find(c => c.conversationId !== conversationId && !c.validated);
  const submit = async fields => {
    setBusy(true); setError(null);
    try {
      const items = data.variables.map(v => ({ variableId: v.id, expectedVerdictId: data.expectedVerdicts[v.id], ...fields[v.id], ...(fields[v.id].outcome !== 'present' ? { messageId: undefined } : {}) }));
      const result = await api(`/comparisons/${sampleId}/validation/${encodeURIComponent(conversationId)}`, { method: 'POST', body: { items } });
      setSaved(result.validation); sample.reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return <div className="validation-page"><PageHeading eyebrow="VALIDACIÓN HUMANA" title={data.conversation.clientName} description={`${data.conversation.agentName} · ${data.conversation.country} · ${data.conversation.id}`} actions={<Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/comparacion?sample=${sampleId}`)}>Volver a la muestra</Button>} />
    {saved ? <div className="validation-saved"><CheckCircleOutlined /><h2>Dictamen guardado</h2><p>Se conservó tu criterio y su evidencia como validación {saved.mode === 'blind' ? 'a ciegas' : 'asistida'}.</p><div><Button onClick={() => navigate(`/comparacion?sample=${sampleId}&reveal=1&case=${encodeURIComponent(conversationId)}`)}>Ver respuestas de este caso</Button>{next && <Button type="primary" onClick={() => { setSaved(null); setError(null); form.resetFields(); navigate(`/comparacion/${sampleId}/validar/${encodeURIComponent(next.conversationId)}`); }}>Validar siguiente <ArrowRightOutlined /></Button>}</div></div> : <>
      <div className="validation-mode"><SafetyCertificateOutlined /><span>{data.mode === 'blind' ? 'Validación a ciegas · Las respuestas de IA permanecen ocultas.' : 'Validación asistida · Ya consultaste resultados equivalentes o guardaste un dictamen en este caso.'}</span><b>{progress}/{data.variables.length} variables</b></div>
      {error && <Alert showIcon type="error" message={error.message} />}
      <div className="validation-grid"><section className="validation-transcript"><div className="panel-heading"><h2>Conversación completa</h2><span>{data.conversation.messages.length} mensajes</span></div><div className="transcript-scroll">{data.conversation.messages.map(m => <article key={m.id} className={`chat-message actor-${m.actor}`}><div className="chat-meta"><b>{{ cliente: 'Cliente', humano: 'Asistente', bot: 'Bot', sistema: 'Sistema' }[m.actor] || m.actor}</b><span>{timeText(m.timestamp)}</span></div><p>{m.text}</p></article>)}</div></section>
      <section className="validation-checklist"><div className="panel-heading"><h2>Tu criterio, con evidencia</h2></div><Form form={form} layout="vertical" onFinish={submit} disabled={busy}><div className="validation-items">{data.variables.map(v => <article className="validation-item" key={v.id}><h3>{v.name}</h3><p>{v.definition}</p>{v.condition && <p className="muted">{v.condition}</p>}<Form.Item name={[v.id, 'outcome']} label="Dictamen" rules={[{ required: true, message: 'Selecciona un dictamen.' }]}><Radio.Group options={[{ value: 'present', label: 'Presente' }, { value: 'absent', label: 'Ausente' }, { value: 'insufficient', label: 'Falta contexto' }]} /></Form.Item>{values?.[v.id]?.outcome === 'present' && <Form.Item name={[v.id, 'messageId']} label="Mensaje de evidencia" rules={[{ required: true, message: 'Selecciona la evidencia.' }]}><Select showSearch optionFilterProp="label" options={data.conversation.messages.map(m => ({ value: m.id, label: `${timeText(m.timestamp)} · ${m.text}` }))} optionRender={option => <span style={{ whiteSpace: 'normal' }}>{option.label}</span>} /></Form.Item>}<Form.Item name={[v.id, 'comment']} label="Motivo" rules={[{ required: true, min: 5, max: 2000, whitespace: true, message: 'Explica el motivo con al menos 5 caracteres.' }]}><Input.TextArea rows={2} maxLength={2000} placeholder="Explica lo que observaste." /></Form.Item></article>)}</div><div className="validation-submit"><span>Completa el checklist de esta conversación para guardar.</span><Button type="primary" htmlType="submit" loading={busy}>Guardar dictamen</Button></div></Form></section></div>
    </>}
  </div>;
}
