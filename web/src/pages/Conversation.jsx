import { conversationReturn } from '../services/conversationNavigation';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Drawer, Tag, Timeline, Tooltip } from 'antd';
import { ArrowLeftOutlined, BarChartOutlined, HistoryOutlined, ProfileOutlined, ReadOutlined } from '@ant-design/icons';
import { useApi } from '../hooks';
import ConversationMetrics from '../components/ConversationMetrics';
import ConversationModelReviews from '../components/ConversationModelReviews';
import ConversationTranscript from '../components/ConversationTranscript';
import ConversationChecklist, { ConversationFlagDetails } from '../components/ConversationChecklist';
import ReviewModal, { reviewActions, canReviewVariable, nextReviewAction } from '../components/ReviewModal';
import { PageHeading, ErrorState, LoadingState, EmptyState, PriorityTag, dateText, timeText } from '../components/common';
import { flagCount, flagVariables, evaluationStatus } from '../services/flags';
import { dailyMetricsView, withMetricDate } from '../services/dailyMetrics';
import { buildMessageFlags } from '../services/messageFlags';
import '../conversation.css';

export default function Conversation() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const returnTarget = conversationReturn(params);
  const requestPath = id ? `/conversations/${encodeURIComponent(id)}` : null;
  const request = useApi(requestPath);
  const [filters, setFilters] = useState({ onlyMarked: false, variableId: null, classification: 'all' });
  const [highlight, setHighlight] = useState({ id: params.get('message'), revision: 0 });
  const [editing, setEditing] = useState(null);
  const [inspector, setInspector] = useState(null);
  const [selectedFlagId, setSelectedFlagId] = useState(null);
  const [selectedMessageFlagId, setSelectedMessageFlagId] = useState(null);
  const [checklistAll, setChecklistAll] = useState(false);
  const conversation = request.data?.conversation;
  const requestedMetricDate = params.get('metricDate');
  const metricSelection = useMemo(() => dailyMetricsView(conversation?.dailyMetrics, requestedMetricDate), [conversation?.dailyMetrics, requestedMetricDate]);
  const messageFlags = useMemo(() => buildMessageFlags(conversation), [conversation]);
  const eligibleFlags = useMemo(() => !conversation || conversation.rawModelView || conversation.evaluation?.sourceChanged ? []
    : flagVariables(conversation.variables).filter(v => canReviewVariable(conversation, v) && nextReviewAction(v) === 'levantar'), [conversation]);
  useEffect(() => {
    setInspector(null); setSelectedFlagId(null); setSelectedMessageFlagId(null); setEditing(null);
    setFilters({ onlyMarked: false, variableId: null, classification: 'all' });
    setHighlight({ id: params.get('message'), revision: 0 });
  }, [id]);
  useEffect(() => {
    if (!requestedMetricDate || request.loading || request.dataPath !== requestPath || !conversation?.dailyMetrics) return;
    if (requestedMetricDate !== metricSelection.selectedDate) setParams(current => withMetricDate(current, metricSelection.selectedDate), { replace: true, preventScrollReset: true });
  }, [requestedMetricDate, request.loading, request.dataPath, requestPath, conversation?.dailyMetrics, metricSelection.selectedDate, setParams]);
  useEffect(() => {
    if (highlight.id && !request.loading) document.getElementById(`message-${highlight.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlight, request.loading]);
  const showMessage = messageId => {
    setSelectedMessageFlagId(null);
    setInspector(null); setFilters({ onlyMarked: false, variableId: null, classification: 'all' });
    setHighlight(value => ({ id: String(messageId), revision: value.revision + 1 }));
  };
  const selectMessageFlag = variableId => {
    setSelectedMessageFlagId(variableId);
    if (!variableId) { setHighlight(value => ({ id: null, revision: value.revision + 1 })); return; }
    setFilters(value => ({ ...value, variableId: null, classification: 'all' }));
    const message = conversation.messages.find(m => messageFlags.byMessage.get(String(m.id))?.some(v => v.id === variableId));
    if (message) setHighlight(value => ({ id: String(message.id), revision: value.revision + 1 }));
  };
  const changeFilters = value => {
    setFilters(value); setSelectedMessageFlagId(null);
    setHighlight(current => ({ id: null, revision: current.revision + 1 }));
  };
  const showFlag = variableId => { setSelectedFlagId(variableId); setInspector('flag'); };
  const showChecklist = (all = false) => { setChecklistAll(all); setInspector('checklist'); };
  if (request.error) return <><Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(returnTarget.to)}>{returnTarget.action}</Button><ErrorState error={request.error} retry={request.reload} /></>;
  if (request.loading || !conversation || request.dataPath !== requestPath) return <LoadingState />;
  const c = conversation;
  const status = evaluationStatus(c);
  const selectedFlag = c.variables.find(v => v.id === selectedFlagId);
  const titles = { checklist: 'Checklist de la evaluación', models: 'Evaluaciones de los modelos', metrics: 'Métricas de la conversación', history: 'Historial de revisiones', flag: selectedFlag?.name || 'Detalle del flag' };
  return <div className="detail-page conversation-focus">
    <div className="breadcrumb-line"><Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate(returnTarget.to)}>{returnTarget.label}</Button><span>/</span><span>Conversación</span><span className="mono muted">{c.id}</span></div>
    <PageHeading eyebrow="CONVERSACIÓN" title={<>{c.client.name}{c.client.phoneLast4 && <span className="heading-phone"> …{c.client.phoneLast4}</span>}</>} description={`${c.agent.name} · ${c.countryName} · ${dateText(c.date)} · ${c.channel}`} actions={<div className="conversation-heading-actions">
      <Button icon={<BarChartOutlined />} onClick={() => setInspector('metrics')}>Métricas</Button>
      <Button icon={<ReadOutlined />} onClick={() => setInspector('models')}>Modelos</Button>
      <Button icon={<ProfileOutlined />} onClick={() => showChecklist()}>Checklist</Button>
      <Button icon={<HistoryOutlined />} onClick={() => setInspector('history')}>Revisiones ({c.reviews.length})</Button>
    </div>} />
    <div className="conversation-meta"><div className="topic-tags">{c.topics.map(topic => <Tag className="neutral-tag" key={topic}>{topic}</Tag>)}</div><span className="muted small">{c.evaluated ? `${c.evaluation.evaluatedCount} variables con resultado` : 'Pendiente de evaluación'}</span><div className="priority-cell">{['critical', 'normal', 'positive'].map(kind => flagCount(c, kind) > 0 && <PriorityTag key={kind} priority={kind} count={flagCount(c, kind)} />)}</div></div>
    {!c.evaluated && <Alert className="detail-alert" showIcon type="info" message="Esta conversación todavía no está evaluada" description="Puedes leer todos los mensajes. Los flags aparecerán cuando se complete su evaluación." />}
    {c.evaluated && ['partial', 'review_pending'].includes(status) && <Alert className="detail-alert" showIcon type="warning" message={status === 'review_pending' ? 'Falta una revisión de modelo' : 'Conversación evaluada con incidencias'} description={status === 'review_pending' ? 'Las respuestas guardadas están en Modelos. Los flags automáticos requieren coincidencia de ambos modelos.' : 'Los resultados válidos están guardados. Algunas variables tienen errores técnicos; no se interpretan como eventos ausentes.'} action={<Button size="small" onClick={() => showChecklist(true)}>Ver detalle</Button>} />}
    {c.evaluated && c.unavailableFlags > 0 && <div className="conversation-context-note"><span>{c.unavailableFlags} variables sin datos o contexto suficientes</span><Button type="link" size="small" onClick={() => showChecklist(true)}>Consultar motivos</Button></div>}
    {c.evaluation?.sourceChanged && <Alert className="detail-alert" showIcon type="warning" message="La conversación cambió desde la evaluación" description="Las marcas anteriores se conservan en el checklist. No se asocian a los mensajes actualizados hasta evaluar de nuevo." />}
    <ConversationTranscript key={c.id} conversation={c} index={messageFlags} eligibleFlags={eligibleFlags} filters={filters} onFiltersChange={changeFilters} highlight={highlight.id} selectedFlagId={selectedMessageFlagId} onSelectFlag={selectMessageFlag} onFocusMessage={messageId => setHighlight(value => ({ id: String(messageId), revision: value.revision + 1 }))} onShowFlag={showFlag} onShowContext={showMessage} onAddFlag={(variable, messageId) => setEditing({ variable, action: 'levantar', messageId })} />
    <Drawer open={!!inspector} title={titles[inspector]} onClose={() => setInspector(null)} width={inspector === 'metrics' ? 1120 : 960} className="conversation-inspector" destroyOnHidden>
      {inspector === 'metrics' && <><ConversationMetrics conversation={c} selectedDate={metricSelection.selectedDate} onDateChange={date => setParams(current => withMetricDate(current, date), { replace: true, preventScrollReset: true })} /><ConversationDescriptors conversation={c} /></>}
      {inspector === 'models' && (c.evaluation?.modelReviews?.length ? <ConversationModelReviews key={c.id} conversation={c} /> : <EmptyState title="Sin revisiones comparables" description="Aquí aparecerán las respuestas guardadas de cada modelo cuando estén disponibles." />)}
      {inspector === 'checklist' && <ConversationChecklist conversation={c} includeAll={checklistAll} onShowFlag={showFlag} />}
      {inspector === 'flag' && selectedFlag && <ConversationFlagDetails conversation={c} variable={selectedFlag} index={messageFlags} onShowMessage={showMessage} onReview={action => setEditing({ variable: selectedFlag, action })} onChecklist={() => showChecklist(true)} />}
      {inspector === 'history' && (c.reviews.length ? <Timeline className="review-timeline" items={[...c.reviews].reverse().map(review => ({ color: review.action === 'refutar' ? 'blue' : review.action === 'levantar' ? 'purple' : 'gray', children: <div><b>{reviewActions[review.action]} · {c.variables.find(v => v.id === review.variableId)?.name}</b><p>{review.comment}</p><small className="muted">{review.authorName} · {dateText(review.createdAt)} {timeText(review.createdAt)}</small></div> }))} /> : <EmptyState title="Sin revisiones humanas" description="Aquí se conservarán las refutaciones, los flags humanos y las acciones de deshacer." />)}
    </Drawer>
    {editing && <ReviewModal conversation={c} editing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); request.reload(); }} />}
  </div>;
}
function ConversationDescriptors({ conversation }) {
  const descriptors = conversation.variables.filter(v => v.type === 'Descriptor' && v.result.status === 'evaluado');
  if (!descriptors.length) return null;
  return <section className="conversation-descriptors" aria-label="Contexto de la conversación">{descriptors.map(v => <div key={v.id}><b>{v.name}</b><span>{Array.isArray(v.result.value) ? v.result.value.join(' · ') || 'Sin elementos' : String(v.result.value ?? 'No disponible')}</span><Tooltip title={v.result.reason}><span className="muted small">Contexto</span></Tooltip></div>)}</section>;
}
