import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Select, Pagination } from 'antd';
import { ArrowRightOutlined, HistoryOutlined, ReloadOutlined, UserOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { defaultDateRange, previousDate } from '../services/dateRange';
import { classificationOf, flagCount, dualMarks } from '../services/flags';
import { buildActiveBoard, visibleBoardMarks } from '../services/activeBoard';
import { PageHeading, LoadingState, EmptyState, ErrorState, Mark, PriorityTag, FlagSymbol, DualBadge, dateText, timeText } from '../components/common';

export default function Active() {
  const { bootstrap } = usePortal();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const country = bootstrap.countries.find(c => c.code === params.get('country')) || bootstrap.countries[0];
  const range = [1, 7, 14, 30].includes(Number(params.get('days'))) ? Number(params.get('days')) : 7;
  const { to } = defaultDateRange(bootstrap.dateRange.max, bootstrap.timezone);
  const from = previousDate(to, range - 1);
  const path = country ? `/summary?${queryString({ country: country.code, from, to })}` : null;
  const { data, dataPath, loading, error, reload } = useApi(path);
  const ready = data && dataPath === path && !loading && !error;
  const groups = ready ? buildActiveBoard(data.conversations, country.code) : [];
  const count = groups.reduce((n, g) => n + g.conversations.length, 0);
  const flagged = groups.reduce((n, g) => n + g.flagged, 0);
  const pending = groups.reduce((n, g) => n + g.pending, 0);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(groups.length / 6)));
  const change = update => { setPage(1); setParams({ country: country?.code || '', days: String(range), ...update }); };

  return <div className="active-page">
    <PageHeading eyebrow="CONVERSACIONES POR ASISTENTE" title="Activas" description="Una vista de la atención por país, a partir del histórico disponible." actions={<span className="active-history-note"><HistoryOutlined /> Histórico · sin datos en vivo</span>} />
    <section className="active-toolbar" aria-label="Filtros de Activas">
      <label>País<Select aria-label="País de Activas" value={country?.code} onChange={country => change({ country })} options={bootstrap.countries.map(c => ({ label: c.name, value: c.code }))} /></label>
      <label>Período<Select aria-label="Período de Activas" value={range} onChange={days => change({ days: String(days) })} options={[1, 7, 14, 30].map(value => ({ value, label: value === 1 ? 'Último día cargado' : `Últimos ${value} días cargados` }))} /></label>
      <span className="active-dates">{dateText(from)} — {dateText(to)}<small>Incluye abiertas y cerradas del período.</small></span>
      <Button aria-label="Actualizar Activas" icon={<ReloadOutlined />} disabled={loading || !country} onClick={reload}>Actualizar</Button>
    </section>
    {!country ? <EmptyState title="No hay países disponibles" /> : error ? <ErrorState error={error} retry={reload} /> : !ready ? <LoadingState /> : <>
      <div className="active-board-heading"><div><h2>{country.name}</h2><span>{count} conversaciones · {flagged} con flags · {pending} pendientes o parciales</span></div><div className="active-legend"><span><Mark kind="critical" />Crítico</span><span><Mark kind="normal" />Normal</span><span><Mark kind="positive" />Positivo</span><span><Mark kind="human" />Humano</span><span><Mark kind="refuted" />Refutado</span></div></div>
      {!groups.length ? <EmptyState /> : <div className="active-board" aria-label={`Asistentes de ${country.name}`}>
        {groups.slice((currentPage - 1) * 6, currentPage * 6).map(group => <section className="assistant-card" key={group.agent.id} aria-label={`Conversaciones de ${group.agent.name}`}>
          <header><span className="assistant-avatar"><UserOutlined /></span><div><h3>{group.agent.name}</h3><span>{group.conversations.length} conversaciones · {group.pending} pendientes</span></div>{group.flagged > 0 && <span className="assistant-flag-count">{group.flagged} con flags</span>}</header>
          <div className="assistant-conversations" tabIndex={0} aria-label={`Lista de conversaciones de ${group.agent.name}`}>
            {group.conversations.map(c => <ConversationEntry key={c.id} conversation={c} />)}
          </div>
        </section>)}
      </div>}
      <footer className="active-footer"><span>Flags primero · Abre una conversación para revisar la evidencia.</span><Pagination current={currentPage} pageSize={6} total={groups.length} showSizeChanger={false} hideOnSinglePage onChange={setPage} size="small" showTotal={total => `${total} asistentes`} /></footer>
    </>}
  </div>;
}

function ConversationEntry({ conversation: c }) {
  const all = visibleBoardMarks(c);
  const marks = all.filter(m => classificationOf(m) !== 'positive');
  const positives = all.filter(m => classificationOf(m) === 'positive');
  return <Link className={`active-conversation ${flagCount(c, 'critical') ? 'has-critical' : flagCount(c, 'normal') ? 'has-flag' : ''}`} to={`/conversacion/${encodeURIComponent(c.id)}`} aria-label={`Ver conversación de ${c.client.name}, ${dateText(c.date)}, ${timeText(c.startedAt)}`}>
    <div className="active-client"><strong>{c.client.name || 'Cliente sin nombre'}</strong><ArrowRightOutlined /></div>
    <div className="active-conversation-meta">{dateText(c.date, { year: undefined })} · {timeText(c.startedAt)} <span>#{c.id}</span></div>
    {marks.length > 0 && <ul className="active-flags">{marks.map(m => <li key={m.id}><FlagSymbol mark={m} /><span>{m.name}{m.kind === 'refuted' && <small>Refutado</small>}</span><PriorityTag priority={classificationOf(m)} /></li>)}</ul>}
    {positives.length > 0 && <div className="active-positive-section"><b><Mark kind="positive" /> Resultados positivos</b><ul className="active-flags">{positives.map(m => <li key={m.id}><FlagSymbol mark={m} /><span>{m.name}{m.kind === 'refuted' && <small>Refutado</small>}</span></li>)}</ul></div>}
    {dualMarks(c).length > 0 && <DualBadge />}
    {!c.evaluated ? <span className="active-pending">Pendiente de evaluación</span> : !c.evaluationIncomplete && !marks.some(m => m.effective) && <span className="active-no-flags">Sin flags vigentes en las variables mostradas</span>}
    {c.evaluated && c.evaluationIncomplete && <span className="active-pending">Evaluación parcial · {c.pendingFlags} flags pendientes</span>}
    {c.sourceChanged && <span className="active-pending">Contenido nuevo pendiente de evaluar</span>}
  </Link>;
}
