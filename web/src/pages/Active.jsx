import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Select, Pagination } from 'antd';
import { HistoryOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { flagCount, noVisibleFlagsLabel, evaluationNeedsAttention, evaluationStatusLabel } from '../services/flags';
import { buildActiveBoard, visibleBoardMarks, compareActiveConversations } from '../services/activeBoard';
import { PageHeading, LoadingState, EmptyState, ErrorState, Mark, FlagSymbol, dateText, timeText } from '../components/common';

export default function Active() {
  const { bootstrap } = usePortal();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const country = bootstrap.countries.find(c => c.code === params.get('country')) || bootstrap.countries[0];
  const path = country ? `/summary?${queryString({ country: country.code })}` : null;
  const { data, dataPath, loading, error, reload } = useApi(path);
  const ready = data && dataPath === path && !loading && !error;
  const groups = ready ? buildActiveBoard(data.conversations, country.code) : [];
  const conversations = groups.flatMap(g => g.conversations).sort(compareActiveConversations);
  const flagged = groups.reduce((n, g) => n + g.flagged, 0);
  const pending = groups.reduce((n, g) => n + g.pending, 0);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(conversations.length / 12)));

  return <div className="active-page">
    <PageHeading eyebrow="CONVERSACIONES POR ASISTENTE" title="Activas" description="Conversaciones por país, con todos los flags vigentes a la vista." actions={<span className="active-history-note"><HistoryOutlined /> Histórico · sin datos en vivo</span>} />
    <section className="active-toolbar" aria-label="Filtros de Activas">
      <label>País<Select aria-label="País de Activas" value={country?.code} onChange={country => { setPage(1); setParams({ country }); }} options={bootstrap.countries.map(c => ({ label: c.name, value: c.code }))} /></label>
      <span className="active-dates">Todo el histórico disponible<small>Incluye conversaciones abiertas y cerradas.</small></span>
      <Button aria-label="Actualizar Activas" icon={<ReloadOutlined />} disabled={loading || !country} onClick={reload}>Actualizar</Button>
    </section>
    {!country ? <EmptyState title="No hay países disponibles" /> : error ? <ErrorState error={error} retry={reload} /> : !ready ? <LoadingState /> : <>
      <div className="active-board-heading"><div><h2>{country.name}</h2><span>{conversations.length} conversaciones · {flagged} con flags · {pending} por completar</span></div><div className="active-legend"><span><Mark kind="critical" />Crítico</span><span><Mark kind="normal" />Normal</span><span><Mark kind="positive" />Positivo</span><span><Mark kind="human" />Revisión humana</span></div></div>
      {!conversations.length ? <EmptyState /> : <div className="active-board active-conversation-board" aria-label={`Conversaciones de ${country.name}`}>
        {conversations.slice((currentPage - 1) * 12, currentPage * 12).map(c => <ConversationEntry key={c.id} conversation={c} />)}
      </div>}
      <footer className="active-footer"><span>Flags primero · Abre una conversación para revisar la evidencia.</span><Pagination current={currentPage} pageSize={12} total={conversations.length} showSizeChanger={false} hideOnSinglePage onChange={setPage} size="small" /></footer>
    </>}
  </div>;
}

function ConversationEntry({ conversation: c }) {
  const marks = visibleBoardMarks(c).filter(m => m.effective !== false && m.kind !== 'refuted');
  const attention = flagCount(c, 'critical') || flagCount(c, 'normal');
  const pending = evaluationNeedsAttention(c) || c.sourceChanged;
  return <Link className={`active-conversation-card ${attention ? 'has-flag' : ''}`} to={`/conversacion/${encodeURIComponent(c.id)}`} aria-label={`Ver conversación de ${c.client.name}, atendida por ${c.agent.name}, ${dateText(c.startedAt)}, ${timeText(c.startedAt)}`}>
    <header><h3>{c.agent.name}</h3><span className={`active-card-status ${attention ? 'flagged' : ''}`}>{attention ? 'Con flags' : pending ? 'Pendiente' : 'OK'}</span></header>
    <div className="active-card-body">
      {marks.length > 0 && <ul className="active-flags">{marks.map(m => <li key={m.id}><FlagSymbol mark={m} /><span>{m.name}</span></li>)}</ul>}
      {c.media?.length > 0 && <div className="active-card-media"><Mark kind="media" /><span>{c.media.join(' · ')}</span></div>}
      {evaluationNeedsAttention(c) ? <span className="active-pending">{evaluationStatusLabel(c)}</span> : !marks.length && <span className="active-no-flags">{noVisibleFlagsLabel(c)}</span>}
      {!evaluationNeedsAttention(c) && c.unavailableFlags > 0 && <span className="muted small">{c.unavailableFlags} variables sin datos suficientes</span>}
      {c.sourceChanged && <span className="active-pending">Contenido nuevo pendiente de evaluar</span>}
    </div>
    <footer><span>Cliente <b>{c.client.name || 'Sin nombre'}{c.client.phoneLast4 ? ` …${c.client.phoneLast4}` : ''}</b></span><span>Inició {dateText(c.startedAt, { year: undefined })} · {timeText(c.startedAt)}</span></footer>
  </Link>;
}
