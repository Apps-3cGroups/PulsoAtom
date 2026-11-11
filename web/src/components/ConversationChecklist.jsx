import { useState } from 'react';
import { Alert, Button, Checkbox, Select } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, EditOutlined } from '@ant-design/icons';
import { EmptyState, FlagSymbol, Mark, PriorityTag, dateText, timeText } from './common';
import FlagModelComparison from './FlagModelComparison';
import { canReviewVariable, nextReviewAction, reviewActions } from './ReviewModal';
import { classificationOf, flagVariables, unmarkedResultLabel } from '../services/flags';

const resultLabel = v => v.kind === 'refuted' ? 'Refutado por humano' : v.kind === 'human' ? 'Levantado por humano'
  : v.kind ? (v.dualDetected ? 'Detectado por ambos modelos' : 'Flag guardado')
    : v.result.error ? 'Error técnico de evaluación' : v.result.status === 'no_evaluado' ? 'Sin datos o contexto suficientes' : unmarkedResultLabel(v);
const evidenceList = value => Array.isArray(value) ? value : value ? [value] : [];
const evidenceKey = evidence => JSON.stringify([evidence.messageId == null ? null : String(evidence.messageId), evidence.quote || '']);
const hasDate = value => !!value && Number.isFinite(Date.parse(value));

export default function ConversationChecklist({ conversation, includeAll, onShowFlag }) {
  const [family, setFamily] = useState(null);
  const [classification, setClassification] = useState('all');
  const [onlyMarked, setOnlyMarked] = useState(false);
  const [unavailable, setUnavailable] = useState(includeAll);
  const catalog = flagVariables(conversation.variables);
  const visible = catalog.filter(v => (!family || v.family === family) && (classification === 'all' || classificationOf(v) === classification)
    && (!onlyMarked || v.kind) && (unavailable || v.kind || v.result.error || (conversation.evaluated ? v.result.status === 'evaluado' : v.enabledInEvaluation)));
  const groups = [...new Set(visible.filter(v => classificationOf(v) !== 'positive').map(v => v.family))].map(name => ({ name, variables: visible.filter(v => v.family === name && classificationOf(v) !== 'positive') }));
  const positives = visible.filter(v => classificationOf(v) === 'positive');
  if (positives.length) groups.push({ name: 'Resultados positivos', variables: positives, positive: true });
  return <section className="conversation-checklist-drawer"><p className="muted">Consulta los criterios de esta evaluación, sus resultados y las revisiones guardadas. Las métricas están en su propio panel.</p>
    <div className="detail-filters"><Select aria-label="Familia del checklist" value={family || undefined} placeholder="Todas las familias" allowClear onChange={setFamily} options={[...new Set(catalog.map(v => v.family))].map(value => ({ value, label: value }))} /><Select aria-label="Clasificación del checklist" value={classification} onChange={setClassification} options={[{ value: 'all', label: 'Todos los flags' }, { value: 'critical', label: 'Críticos' }, { value: 'normal', label: 'Menores' }, { value: 'positive', label: '+ Positivos' }]} /><Checkbox checked={onlyMarked} onChange={e => setOnlyMarked(e.target.checked)}>Solo con marca</Checkbox><Checkbox checked={unavailable} onChange={e => setUnavailable(e.target.checked)}>Mostrar no evaluadas</Checkbox></div>
    <p className="checklist-visible-count" role="status">{visible.length} variables visibles</p>
    {!groups.length && <EmptyState title="Sin variables con estos filtros" description="Prueba otra familia o muestra también las no evaluadas." />}
    {groups.map(group => <div className={`checklist-family ${group.positive ? 'positive-checklist-section' : ''}`} key={group.name}><h3>{group.positive && <Mark kind="positive" />}{group.name}<span>{group.variables.length}</span></h3>{group.variables.map(v => <button className="checklist-summary-row" key={v.id} onClick={() => onShowFlag(v.id)}><span className="variable-symbol">{v.kind ? <FlagSymbol mark={v} /> : <span className="empty-symbol" />}</span><span><b>{v.name}</b><small>{resultLabel(v)}{!v.enabledInEvaluation ? ' · Fuera del checklist evaluado' : ''}</small></span><PriorityTag priority={classificationOf(v)} /><ArrowRightOutlined /></button>)}</div>)}
  </section>;
}

export function ConversationFlagDetails({ conversation, variable: v, index, onShowMessage, onReview, onChecklist }) {
  const sourceChanged = conversation.sourceChanged || conversation.evaluation?.sourceChanged;
  const canReview = !conversation.rawModelView && !sourceChanged && canReviewVariable(conversation, v);
  const action = nextReviewAction(v);
  const messages = conversation.messages || [];
  const evidenceMessages = sourceChanged ? [] : messages.filter(m => index.byMessage.get(String(m.id))?.some(mark => mark.id === v.id));
  const linkedIds = new Set(evidenceMessages.map(message => String(message.id)));
  const comparison = v.result.comparison && !v.result.comparison.codeOnly ? v.result.comparison : null;
  const visibleEvidence = new Set((comparison?.cells || []).flatMap(cell => evidenceList(cell.result?.evidence)).filter(Boolean).map(evidenceKey));
  const savedEvidence = [
    ...evidenceList(v.review?.evidence).map(evidence => ({ evidence, source: 'Revisión humana' })),
    ...evidenceList(v.result.evidence).map(evidence => ({ evidence, source: 'Resultado guardado' })),
  ].filter(({ evidence }) => {
    if (!evidence || linkedIds.has(String(evidence.messageId)) || visibleEvidence.has(evidenceKey(evidence))) return false;
    visibleEvidence.add(evidenceKey(evidence));
    return true;
  });
  return <section className="conversation-flag-details">
    <Button type="text" icon={<ArrowLeftOutlined />} onClick={onChecklist}>Volver al checklist</Button>
    <div className="flag-details-heading"><div>{v.kind && <FlagSymbol mark={v} />}<PriorityTag priority={classificationOf(v)} /><span className="muted">Versión {v.version}</span></div>{canReview && <Button icon={<EditOutlined />} onClick={() => onReview(action)}>{reviewActions[action]}</Button>}</div>
    <p className="flag-details-status">{resultLabel(v)}</p>
    {v.review && <div className="flag-human-record"><b>{v.review.action === 'refutar' ? 'Refutación humana' : 'Flag humano'}</b><p>{v.review.comment}</p><small>{v.review.authorName} · {dateText(v.review.createdAt)} · {timeText(v.review.createdAt)}{v.verdict?.id === v.review.id ? ` · ${v.verdict.mode === 'blind' ? 'A ciegas' : 'Asistido'}` : ''}</small></div>}
    {!conversation.rawModelView && v.verdict && v.verdict.id !== v.review?.id && <div className="review-note"><b>Dictamen: {{ present: 'evento presente', absent: 'evento ausente', insufficient: 'contexto insuficiente', reverted: 'revertido' }[v.verdict.outcome]}</b><p>{v.verdict.comment}</p><small>{v.verdict.authorName} · {dateText(v.verdict.createdAt)} · {v.verdict.mode === 'blind' ? 'A ciegas' : 'Asistido'}</small></div>}
    {v.result.error && <Alert showIcon type="warning" message="Esta variable tuvo un error técnico" description={v.result.reason} />}
    {comparison ? <FlagModelComparison variable={v} demo={conversation.demo} /> : <><div className="flag-criterion"><b>Criterio evaluado</b><p>{v.definition}</p>{v.condition && <p>{v.condition}</p>}</div><p className="muted">{v.result.reason || 'Sin justificación registrada.'}</p>{v.result.comparison?.codeOnly && <p className="muted">Resultado calculado por código; no representa dos votos de IA.</p>}</>}
    {savedEvidence.length > 0 && <section className="flag-linked-messages" aria-label="Evidencia guardada"><h3>Evidencia guardada</h3>{savedEvidence.map(({ evidence, source }, position) => {
      const message = !sourceChanged && evidence.messageId != null ? messages.find(item => String(item.id) === String(evidence.messageId)) : null;
      const content = <><span>{evidence.quote || 'Sin cita textual guardada.'}</span><span className="evidence-meta"><span>{source}{evidence.messageId != null ? ` · Mensaje ${evidence.messageId}` : ''}</span>{message && <><span>Ver en la conversación</span><ArrowRightOutlined /></>}</span></>;
      return message ? <button type="button" className="evidence-quote" key={position} onClick={() => onShowMessage(message.id)}>{content}</button> : <blockquote className="evidence-quote" key={position}>{content}</blockquote>;
    })}</section>}
    <div className="flag-linked-messages"><h3>Mensajes vinculados ({evidenceMessages.length})</h3>{evidenceMessages.map(m => <button type="button" className="evidence-quote" key={m.id} onClick={() => onShowMessage(m.id)}><span>{m.text}</span><span className="evidence-meta">{hasDate(m.timestamp) ? `${dateText(m.timestamp)} · ${timeText(m.timestamp)}` : 'Fecha no disponible'}<span>Ver en la conversación</span><ArrowRightOutlined /></span></button>)}{!evidenceMessages.length && <p className="muted">{sourceChanged ? 'El contenido cambió. Las citas guardadas corresponden a la evaluación anterior y no se vinculan a los mensajes actuales.' : 'Este resultado no tiene una marca vinculada a un mensaje actual.'}</p>}</div>
  </section>;
}
