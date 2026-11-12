import { conversationLink } from '../services/conversationNavigation';
import { useEffect } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Button, Select, Pagination } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { flagCount, noVisibleFlagsLabel, evaluationNeedsAttention, evaluationStatusLabel } from '../services/flags';
import { visibleBoardMarks } from '../services/activeBoard';
import { selectedCountries } from '../services/summaryFilters';
import { LoadingState, EmptyState, ErrorState, Mark, FlagSymbol, dateText, timeText } from '../components/common';
import './Active.css';

const pollRuns = data => data.runs?.some(run => ['scheduled', 'waiting_ingestion', 'waiting_evaluation', 'running'].includes(run.status));
export default function Active() {
  const { bootstrap } = usePortal();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const countries = selectedCountries(params, bootstrap.countries);
  const requestedPage = Number(params.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const patch = values => setParams(previous => {
    const next = new URLSearchParams(previous);
    if (!next.has('countries') && next.has('country')) next.set('countries', next.get('country'));
    next.delete('country');
    for (const [key, value] of Object.entries(values)) value == null ? next.delete(key) : next.set(key, String(value));
    return next;
  });
  const path = `/active?${queryString({ countries: countries.join(','), page, pageSize: 12 })}`;
  const { data, dataPath, loading, error, reload } = useApi(path, { timeoutMs: 60000, pollIntervalMs: 30000, pollWhile: pollRuns });
  const ready = data && dataPath === path && !error;
  useEffect(() => {
    if (ready && page > Math.max(1, Math.ceil(data.total / 12))) patch({ page: Math.max(1, Math.ceil(data.total / 12)) });
  }, [ready, data?.total, page]);
  return <div className="active-page">
    <h1 className="visually-hidden">Activas</h1>
    <section className="active-toolbar" aria-label="Filtros de Activas">
      <Select mode="multiple" allowClear showSearch maxTagCount="responsive" optionFilterProp="label" aria-label="Países de Activas" placeholder="Todos los países" className="country-multiselect" styles={{ popup: { root: { zIndex: 1100 } } }} value={countries} onChange={values => patch({ countries: values.length ? values.sort().join(',') : null, page: null })} options={bootstrap.countries.map(c => ({ label: c.name, value: c.code }))} />
      <div className="active-legend" aria-label="Simbología de flags"><span><Mark kind="critical" />Crítico</span><span><Mark kind="normal" />Menor</span><span><Mark kind="positive" />Positivo</span><span><Mark kind="human" />Revisión humana</span></div>
      <Button aria-label="Actualizar Activas" title="Actualizar Activas" icon={<ReloadOutlined />} loading={loading} onClick={reload} />
    </section>
    {error ? <ErrorState error={error} retry={reload} /> : !ready ? <LoadingState /> : <>
      {!data.total ? <EmptyState title="No hay conversaciones activas" description="No hay conversaciones en atención para los países seleccionados." /> : <div className="active-board active-conversation-board" aria-label="Conversaciones en atención">
        {data.items.map(c => <ConversationEntry key={c.id} conversation={c} returnTo={`${location.pathname}${location.search}`} showCountry={countries.length !== 1} />)}
      </div>}
      <footer className="active-footer"><span>Flags primero · Abre una conversación para revisar la evidencia.</span><Pagination current={page} pageSize={12} total={data.total} showSizeChanger={false} hideOnSinglePage onChange={value => patch({ page: value })} size="small" /></footer>
    </>}
  </div>;
}

function ConversationEntry({ conversation: c, showCountry, returnTo }) {
  const marks = visibleBoardMarks(c).filter(m => m.effective !== false && m.kind !== 'refuted');
  const media = (c.media || []).filter(kind => String(kind).trim().toLowerCase() !== 'archivo');
  const attention = flagCount(c, 'critical') || flagCount(c, 'normal');
  const pending = evaluationNeedsAttention(c) || c.sourceChanged;
  const clientLabel = `${c.client.name || 'Sin nombre'}${c.client.phoneLast4 ? ` …${c.client.phoneLast4}` : ''}`;
  return <Link className={`active-conversation-card ${attention ? 'has-flag' : ''}`} to={conversationLink(c.id, returnTo)} aria-label={`Ver conversación de ${c.client.name}, atendida por ${c.agent.name}, ${dateText(c.startedAt)}, ${timeText(c.startedAt)}`}>
    <header><div><h3 title={c.agent.name}>{c.agent.name}</h3>{showCountry && <div className="active-card-country">{c.countryName || c.country}</div>}</div><span className={`active-card-status ${attention ? 'flagged' : ''}`}>{attention ? 'Con flags' : pending ? 'Pendiente' : 'OK'}</span></header>
    <div className="active-card-body">
      {c.activeReason?.code === 'friday-cohort' && <span className="active-pending">{c.activeReason.label}</span>}
      {marks.length > 0 && <ul className="active-flags">{marks.map(m => <li key={m.id}><FlagSymbol mark={m} /><span>{m.name}</span></li>)}</ul>}
      {media.length > 0 && <div className="active-card-media"><Mark kind="media" /><span>{media.join(' · ')}</span></div>}
      {evaluationNeedsAttention(c) ? <span className="active-pending">{evaluationStatusLabel(c)}</span> : !marks.length && <span className="active-no-flags">{noVisibleFlagsLabel(c)}</span>}
      {!evaluationNeedsAttention(c) && c.unavailableFlags > 0 && <span className="muted small">{c.unavailableFlags} variables sin datos suficientes</span>}
      {c.sourceChanged && <span className="active-pending">Contenido nuevo pendiente de evaluar</span>}
    </div>
    <footer><span title={`Cliente ${clientLabel}`}>Cliente <b>{clientLabel}</b></span><span>Inició {dateText(c.startedAt, { year: undefined })} · {timeText(c.startedAt)}</span></footer>
  </Link>;
}
