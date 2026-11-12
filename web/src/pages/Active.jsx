import { conversationLink } from '../services/conversationNavigation';
import { useEffect } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Button, Pagination } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { classificationOf, flagCount, noVisibleFlagsLabel, evaluationNeedsAttention, evaluationStatusLabel } from '../services/flags';
import { activeFigureKinds, activeRequestPath, visibleActiveMarks } from '../services/activeBoard';
import { selectedCountries, selectedFigures, cleanOverviewParams } from '../services/summaryFilters';
import { CountrySelect, ExceptionsFilter } from '../components/ExceptionControls';
import { LoadingState, EmptyState, ErrorState, Mark, dateText, timeText } from '../components/common';
import './Active.css';

const pollRuns = data => data.runs?.some(run => ['scheduled', 'waiting_ingestion', 'waiting_evaluation', 'running'].includes(run.status));
export default function Active() {
  const { bootstrap } = usePortal();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const countries = selectedCountries(params, bootstrap.countries);
  const visible = selectedFigures(params, activeFigureKinds);
  const requestedPage = Number(params.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const patch = values => setParams(previous => {
    const next = cleanOverviewParams(previous);
    for (const [key, value] of Object.entries(values)) value == null ? next.delete(key) : next.set(key, String(value));
    return next;
  });
  useEffect(() => {
    const next = cleanOverviewParams(params);
    if (next.has('figures')) next.set('figures', visible.join(','));
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [params, setParams]);
  const toggle = kind => patch({ figures: (visible.includes(kind) ? visible.filter(v => v !== kind) : [...visible, kind]).join(','), page: null });
  const path = activeRequestPath({ countries, page, figures: visible });
  const { data, dataPath, loading, error, reload } = useApi(path, { timeoutMs: 60000, pollIntervalMs: 30000, pollWhile: pollRuns });
  const ready = data && dataPath === path && !error;
  useEffect(() => {
    if (ready && page > Math.max(1, Math.ceil(data.total / 12))) patch({ page: Math.max(1, Math.ceil(data.total / 12)) });
  }, [ready, data?.total, page]);
  return <div className="active-page">
    <h1 className="visually-hidden">Activas</h1>
    <section className="active-toolbar" aria-label="Filtros de Activas">
      <div className="active-legend" aria-label="Excepciones de Activas"><ExceptionsFilter kinds={activeFigureKinds} selected={visible} onToggle={toggle} /></div>
      <CountrySelect label="Países de Activas" countries={bootstrap.countries} value={countries} onChange={values => patch({ countries: values.length ? values.sort().join(',') : null, page: null })} />
      <Button aria-label="Actualizar Activas" title="Actualizar Activas" icon={<ReloadOutlined />} loading={loading} onClick={reload} />
    </section>
    {error ? <ErrorState error={error} retry={reload} /> : !ready ? <LoadingState /> : <>
      {!data.total ? <EmptyState title={visible.length ? "Sin coincidencias" : "Ninguna excepción seleccionada"} description={visible.length ? "No hay conversaciones activas evaluadas que coincidan con los países y las excepciones seleccionadas." : "Selecciona alguna excepción para mostrar conversaciones."} action={<Button onClick={() => patch({ figures: null, page: null })}>Restablecer excepciones</Button>} /> : <div className="active-board active-conversation-board" aria-label="Conversaciones en atención">
        {data.items.map(c => <ConversationEntry key={c.id} conversation={c} visible={visible} returnTo={`${location.pathname}${location.search}`} showCountry={countries.length !== 1} />)}
      </div>}
      <footer className="active-footer"><span>Flags primero · Abre una conversación para revisar la evidencia.</span><Pagination current={page} pageSize={12} total={data.total} showSizeChanger={false} hideOnSinglePage onChange={value => patch({ page: value })} size="small" /></footer>
    </>}
  </div>;
}

export function ConversationEntry({ conversation: c, showCountry, returnTo, visible = activeFigureKinds }) {
  const marks = visibleActiveMarks(c, visible);
  const media = (c.media || []).filter(kind => String(kind).trim().toLowerCase() !== 'archivo');
  const attention = flagCount(c, 'critical') || flagCount(c, 'normal');
  const pending = evaluationNeedsAttention(c) || c.sourceChanged;
  const clientLabel = `${c.client.name || 'Sin nombre'}${c.client.phoneLast4 ? ` …${c.client.phoneLast4}` : ''}`;
  return <Link className={`active-conversation-card ${attention ? 'has-flag' : ''}`} to={conversationLink(c.id, returnTo)} aria-label={`Ver conversación de ${c.client.name}, atendida por ${c.agent.name}, ${dateText(c.startedAt)}, ${timeText(c.startedAt)}`}>
    <header><div><h3 title={c.agent.name}>{c.agent.name}</h3>{showCountry && <div className="active-card-country">{c.countryName || c.country}</div>}</div><span className={`active-card-status ${attention ? 'flagged' : ''}`}>{attention ? 'Con flags' : pending ? 'Pendiente' : 'OK'}</span></header>
    <div className="active-card-body">
      {c.activeReason?.code === 'friday-cohort' && <span className="active-pending">{c.activeReason.label}</span>}
      {marks.length > 0 && <ul className="active-flags">{marks.map(m => <li key={m.id}><Mark kind={classificationOf(m)} /><span>{m.name}</span></li>)}</ul>}
      {media.length > 0 && <div className="active-card-media"><Mark kind="media" /><span>{media.join(' · ')}</span></div>}
      {evaluationNeedsAttention(c) ? <span className="active-pending">{evaluationStatusLabel(c)}</span> : !marks.length && <span className="active-no-flags">{noVisibleFlagsLabel(c)}</span>}
      {!evaluationNeedsAttention(c) && c.unavailableFlags > 0 && <span className="muted small">{c.unavailableFlags} variables sin datos suficientes</span>}
      {c.sourceChanged && <span className="active-pending">Contenido nuevo pendiente de evaluar</span>}
    </div>
    <footer><span title={`Cliente ${clientLabel}`}>Cliente <b>{clientLabel}</b></span><span>Inició {dateText(c.startedAt, { year: undefined })} · {timeText(c.startedAt)}</span></footer>
  </Link>;
}
