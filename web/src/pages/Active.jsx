import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Select, Pagination } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { flagCount, noVisibleFlagsLabel, evaluationNeedsAttention, evaluationStatusLabel } from '../services/flags';
import { visibleBoardMarks } from '../services/activeBoard';
import { selectedCountries } from '../services/summaryFilters';
import { PageHeading, LoadingState, EmptyState, ErrorState, Mark, FlagSymbol, dateText, timeText } from '../components/common';

const pollRuns = data => data.runs?.some(run => ['scheduled', 'waiting_ingestion', 'waiting_evaluation', 'running'].includes(run.status));
export default function Active() {
  const { bootstrap } = usePortal();
  const [params, setParams] = useSearchParams();
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
  const heading = countries.length === 1 ? bootstrap.countries.find(c => c.code === countries[0])?.name : countries.length ? 'Países seleccionados' : 'Todos los países';
  return <div className="active-page">
    <PageHeading eyebrow="CONVERSACIONES POR ASISTENTE" title="Activas" description="Conversaciones en atención y lotes vigentes, con todos sus flags a la vista." />
    <section className="active-toolbar" aria-label="Filtros de Activas">
      <label>Países<Select mode="multiple" allowClear showSearch optionFilterProp="label" aria-label="Países de Activas" placeholder="Todos los países" className="country-multiselect" value={countries} onChange={values => patch({ countries: values.length ? values.sort().join(',') : null, page: null })} options={bootstrap.countries.map(c => ({ label: c.name, value: c.code }))} /></label>
      <span className="active-dates">En atención<small>Abiertas, reasignadas y reingresadas sin cierre.</small></span>
      <Button aria-label="Actualizar Activas" icon={<ReloadOutlined />} loading={loading} onClick={reload}>Actualizar</Button>
    </section>
    {error ? <ErrorState error={error} retry={reload} /> : !ready ? <LoadingState /> : <>
      {data.runs?.map(run => <Alert className="active-run-status" key={run.id} type={['blocked', 'failed', 'not_started'].includes(run.status) ? 'warning' : 'info'} message={`${run.label}: ${run.statusLabel}`} description={run.reason || (run.total ? `${run.completed} de ${run.total} evaluaciones registradas` : undefined)} />)}
      <div className="active-board-heading"><div><h2>{heading}</h2><span>{data.total} conversaciones · {data.metrics.withAlerts} con flags · {data.pending} por completar</span></div><div className="active-legend"><span><Mark kind="critical" />Crítico</span><span><Mark kind="normal" />Menor</span><span><Mark kind="positive" />Positivo</span><span><Mark kind="human" />Revisión humana</span></div></div>
      {!data.total ? <EmptyState description="No hay conversaciones en atención para los países seleccionados." /> : <div className="active-board active-conversation-board" aria-label="Conversaciones en atención">
        {data.items.map(c => <ConversationEntry key={c.id} conversation={c} showCountry={countries.length !== 1} />)}
      </div>}
      <footer className="active-footer"><span>Flags primero · Abre una conversación para revisar la evidencia.</span><Pagination current={page} pageSize={12} total={data.total} showSizeChanger={false} hideOnSinglePage onChange={value => patch({ page: value })} size="small" /></footer>
    </>}
  </div>;
}

function ConversationEntry({ conversation: c, showCountry }) {
  const marks = visibleBoardMarks(c).filter(m => m.effective !== false && m.kind !== 'refuted');
  const attention = flagCount(c, 'critical') || flagCount(c, 'normal');
  const pending = evaluationNeedsAttention(c) || c.sourceChanged;
  return <Link className={`active-conversation-card ${attention ? 'has-flag' : ''}`} to={`/conversacion/${encodeURIComponent(c.id)}`} aria-label={`Ver conversación de ${c.client.name}, atendida por ${c.agent.name}, ${dateText(c.startedAt)}, ${timeText(c.startedAt)}`}>
    <header><div><h3>{c.agent.name}</h3>{showCountry && <div className="active-card-country">{c.countryName || c.country}</div>}</div><span className={`active-card-status ${attention ? 'flagged' : ''}`}>{attention ? 'Con flags' : pending ? 'Pendiente' : 'OK'}</span></header>
    <div className="active-card-body">
      {c.activeReason?.code === 'friday-cohort' && <span className="active-pending">{c.activeReason.label}</span>}
      {marks.length > 0 && <ul className="active-flags">{marks.map(m => <li key={m.id}><FlagSymbol mark={m} /><span>{m.name}</span></li>)}</ul>}
      {c.media?.length > 0 && <div className="active-card-media"><Mark kind="media" /><span>{c.media.join(' · ')}</span></div>}
      {evaluationNeedsAttention(c) ? <span className="active-pending">{evaluationStatusLabel(c)}</span> : !marks.length && <span className="active-no-flags">{noVisibleFlagsLabel(c)}</span>}
      {!evaluationNeedsAttention(c) && c.unavailableFlags > 0 && <span className="muted small">{c.unavailableFlags} variables sin datos suficientes</span>}
      {c.sourceChanged && <span className="active-pending">Contenido nuevo pendiente de evaluar</span>}
    </div>
    <footer><span>Cliente <b>{c.client.name || 'Sin nombre'}{c.client.phoneLast4 ? ` …${c.client.phoneLast4}` : ''}</b></span><span>Inició {dateText(c.startedAt, { year: undefined })} · {timeText(c.startedAt)}</span></footer>
  </Link>;
}
