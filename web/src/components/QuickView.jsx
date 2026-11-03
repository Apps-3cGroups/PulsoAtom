import FlagModelComparison from './FlagModelComparison';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Drawer } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import { useApi } from '../hooks';
import { ErrorState, LoadingState, Mark, PriorityTag, dateText, timeText } from './common';
import ReviewModal, { canReviewVariable, reviewReasons } from './ReviewModal';

const priorityRank = item => item.priority === 'P1' ? 0 : item.priority === 'P2' ? 1 : 2;

function Evidence({ items, conversation, label }) {
  const quotes = items?.filter(Boolean) || [];
  return <div className="quick-view-evidence-list">{quotes.length ? quotes.map((item, index) => <blockquote className="quick-view-evidence" key={`${item.messageId}-${index}`}><p>“{item.quote}”</p><footer>{label} · {timeText(conversation.messages.find(message => message.id === item.messageId)?.timestamp)}</footer></blockquote>) : <p className="quick-view-empty">No hay una cita de evidencia registrada.</p>}</div>;
}

export default function QuickView({ selected, onClose, onOpen, onSaved }) {
  const request = useApi(selected ? `/conversations/${encodeURIComponent(selected.id)}` : null);
  const [editing, setEditing] = useState(null);
  const [comparing, setComparing] = useState(null);
  const contentRef = useRef(null);
  useLayoutEffect(() => { contentRef.current?.closest('.ant-drawer-body')?.scrollTo({ top: 0 }); }, [comparing, selected?.id]);
  useEffect(() => { setEditing(null); setComparing(null); }, [selected?.id]);
  const conversation = request.data?.conversation;
  const current = conversation?.id === selected?.id ? conversation : null;
  const compared = current?.variables.find(v => v.id === comparing);
  useEffect(() => { if (!current?.evaluation?.modelReviewPending || request.loading || request.error) return; const timer = setTimeout(request.reload, 3000); return () => clearTimeout(timer); }, [current?.evaluation?.modelReviewPending, request.loading, request.error, request.reload]);
  const reviewable = (current?.variables || []).filter(item => canReviewVariable(current, item));
  const reviewed = (current?.variables || []).filter(item => item.review).sort((a, b) => priorityRank(a) - priorityRank(b));
  const active = reviewable.filter(item => !item.review && item.result.value === 1).sort((a, b) => priorityRank(a) - priorityRank(b));
  const counts = current || selected;
  const saved = () => { setEditing(null); request.reload(); onSaved(); };

  return <Drawer className="quick-view-drawer" title="Vista rápida" placement="right" width={compared ? 'min(920px, 100vw)' : 'min(480px, 100vw)'} open={!!selected} onClose={onClose} mask={false} styles={{ body: { padding: 0 } }} footer={<Button type="primary" block onClick={onOpen} disabled={!selected}>Ver conversación completa <ArrowRightOutlined /></Button>}>
    {selected && <>
      <div className={`quick-view-intro ${compared ? 'quick-view-intro-compact' : ''}`}><span className="eyebrow">CONVERSACIÓN · {selected.country}</span><h2>{selected.client.name}</h2><p>{selected.agent.name} · {dateText(selected.date)} · {timeText(selected.startedAt)}</p><p>{selected.channel}{selected.client.phoneLast4 ? ` · Cliente …${selected.client.phoneLast4}` : ''}</p><div className="quick-view-priorities">{counts.evaluated ? <>{counts.p1 > 0 && <PriorityTag priority="P1" count={counts.p1} />}{counts.p2 > 0 && <PriorityTag priority="P2" count={counts.p2} />}{counts.p1 + counts.p2 === 0 && <span className="quick-view-neutral">Sin P1/P2 vigentes</span>}</> : <span className="quick-view-neutral">Pendiente de evaluación</span>}</div></div>
      <div ref={contentRef} className="quick-view-content">{request.error ? <ErrorState error={request.error} retry={request.reload} /> : !current ? <LoadingState /> : compared ? <section><Button type="text" onClick={() => setComparing(null)}>← Volver a los flags</Button><h2>{compared.name}</h2><FlagModelComparison variable={compared} demo={current.demo} />{compared.review && <div className="review-note"><strong>{compared.review.action === 'refutar' ? 'Refutado' : 'Revisión humana'} · {compared.review.authorName}</strong><p>{reviewReasons[compared.review.reason] || compared.review.reason}: {compared.review.comment}</p><small>{dateText(compared.review.createdAt)} · {timeText(compared.review.createdAt)}</small></div>}{!compared.review && compared.result.value === 1 && <Button className="flag-refute-button" disabled={current.evaluation?.sourceChanged} onClick={() => setEditing({ variable: compared, action: 'refutar' })}>Refutar este flag</Button>}</section> : !current.evaluated ? <p className="quick-view-empty">Todavía no hay resultados del checklist. Consulta la conversación completa para leer sus mensajes.</p> : <>
        {reviewed.length > 0 && <section><h3>Revisiones humanas</h3><div className="quick-view-alerts">{reviewed.map(item => <article className="quick-view-review" key={item.id}><div className="quick-view-alert-title"><Mark kind={item.kind} /><b>{item.name}</b>{item.priority && <PriorityTag priority={item.priority} />}</div><div className="quick-view-review-body">{item.result.comparison && <Button className="flag-compare-button" onClick={() => setComparing(item.id)}>{item.result.comparison.label} · Ver revisiones</Button>}<span className="quick-view-status">{item.review.action === 'refutar' ? 'Refutado' : 'Levantado por humano'}</span><p><strong>Observación original:</strong> {item.result.value === 1 ? `El sistema marcó “${item.name}”.` : `El sistema no detectó “${item.name}”.`}</p>{item.result.value === 1 && <Evidence items={item.result.evidence} conversation={current} label="Evidencia original" />}{item.review.action === 'levantar' && <Evidence items={[item.review.evidence]} conversation={current} label="Evidencia humana" />}<p><strong>Motivo:</strong> {reviewReasons[item.review.reason] || item.review.reason}</p><p><strong>Comentario:</strong> {item.review.comment}</p><p className="quick-view-author"><strong>{item.review.action === 'refutar' ? 'Refutó' : 'Levantó'}:</strong> {item.review.authorName} · {dateText(item.review.createdAt)} {timeText(item.review.createdAt)}</p></div></article>)}</div></section>}
        {current.evaluation?.sourceChanged && <p className="attempt-error">El contenido de Atom cambió. Evalúa la conversación actual antes de refutar.</p>}<section><h3>Flags vigentes del sistema</h3>{active.length ? <div className="quick-view-alerts">{active.map(item => <article className="quick-view-review" key={item.id}><div className="quick-view-alert-title"><Mark kind={item.kind || 'coaching'} /><b>{item.name}</b>{item.priority && <PriorityTag priority={item.priority} />}</div><div className="quick-view-review-body">{item.result.comparison && <Button className="flag-compare-button" onClick={() => setComparing(item.id)}>{item.result.comparison.label} · Ver revisiones</Button>}<Evidence items={item.result.evidence} conversation={current} label="Evidencia del sistema" />{!current.rawModelView && <Button disabled={current.evaluation?.sourceChanged} size="small" onClick={() => setEditing({ variable: item, action: 'refutar' })}>Refutar flag</Button>}</div></article>)}</div> : <p className="quick-view-empty">No hay flags del sistema vigentes en las variables evaluadas.</p>}</section>
      </>}</div>
    </>}
    {editing && current && <ReviewModal key={`${current.id}:${editing.variable.id}`} conversation={current} editing={editing} onClose={() => setEditing(null)} onSaved={saved} />}
  </Drawer>;
}
