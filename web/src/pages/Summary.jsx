import { countryLabel } from '../services/presentationText';
import { conversationLink } from '../services/conversationNavigation';
import { selectedCountries, selectedFigures, figureKinds, cleanOverviewParams, filterSummaryConversations, summaryMetrics } from '../services/summaryFilters';
import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, ConfigProvider, Tooltip } from 'antd';
import { AppstoreOutlined, CalendarOutlined, InfoCircleOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { LoadingState, ErrorState, EmptyState, Mark, dateText, timeText } from '../components/common';
import { resolveSummaryRange, summaryDayWindow, SUMMARY_PRESETS } from '../services/summaryDates';
import { summaryRangeLabel, summaryPercentage } from '../services/summaryPresentation';
import { buildSummaryLanes } from '../services/summaryMap';
import CompactSummaryMap from '../components/CompactSummaryMap';
import { CountrySelect, ExceptionsFilter } from '../components/ExceptionControls';
import { useAppearance } from '../appearance';
import { classificationOf, dualMarks, markKind, noVisibleFlagsLabel, evaluationStatus, evaluationStatusLabel } from '../services/flags';
import './Summary.css';

const countTooltip = (count, total, description) => <div className="summary-stat-tooltip">
  <strong>{count.toLocaleString('es-HN')} {count === 1 ? 'conversación' : 'conversaciones'} {description}</strong>
  <span>{total ? `De ${total.toLocaleString('es-HN')} ${total === 1 ? 'conversación visible' : 'conversaciones visibles'}.` : 'No hay conversaciones con estos filtros.'}</span>
</div>;
export default function Summary() {
  const { bootstrap } = usePortal();
  const { fontScale } = useAppearance();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const mapRef = useRef(null);
  const countries = selectedCountries(params, bootstrap.countries);
  const classification = 'all';
  const visible = selectedFigures(params);
  const patchFilters = values => setParams(previous => {
    const next = cleanOverviewParams(previous);
    for (const [key, value] of Object.entries(values)) value == null ? next.delete(key) : next.set(key, value);
    return next;
  });
  useEffect(() => {
    const next = cleanOverviewParams(params);
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [params, setParams]);
  const { from, to, preset } = resolveSummaryRange({
    days: params.get('days'),
    latest: bootstrap.activityDateRange?.max || bootstrap.dateRange.max,
    mode: bootstrap.mode, timezone: bootstrap.timezone,
  });
  const summaryPath = `/summary?${queryString({ from, to, countries: countries.join(','), dateBasis: 'activity' })}`;
  const { data, dataPath, loading, error, reload } = useApi(summaryPath, { timeoutMs: 60000 });
  const waiting = loading || dataPath !== summaryPath;
  const current = !waiting && !error ? data : null;
  const window = useMemo(() => summaryDayWindow({ from, to }), [from, to]);
  const { days } = window;
  useEffect(() => { mapRef.current?.scrollTo(0, 0); }, [from, to]);
  const changeRange = values => {
    setParams(previous => {
      const next = cleanOverviewParams(previous);
      ['from', 'to', 'days'].forEach(key => next.delete(key));
      for (const [key, value] of Object.entries(values)) next.set(key, String(value));
      return next;
    }, { replace: true });
  };
  const open = c => navigate(conversationLink(c.id, `${location.pathname}${location.search}`));
  const openHistory = code => navigate(`/historico?${queryString({ from, to, country: code, dateBasis: 'activity' })}`);
  const toggle = kind => patchFilters({ figures: (visible.includes(kind) ? visible.filter(v => v !== kind) : [...visible, kind]).join(',') });
  const filtered = useMemo(() => filterSummaryConversations(current?.conversations || [], visible), [current, visible.join(',')]);
  const metrics = current ? summaryMetrics(filtered) : null;
  const flagPercentage = summaryPercentage(metrics?.withAlerts, metrics?.total);
  const positivePercentage = summaryPercentage(metrics?.withPositives, metrics?.total);
  const groups = useMemo(() => buildSummaryLanes(filtered, bootstrap.countries, days), [filtered, bootstrap.countries, days]);
  return <div className={`summary-page ${preset === 30 ? 'summary-month' : ''}`}>
    <h1 className="visually-hidden">Resumen de conversaciones</h1>
    <div className="summary-stats-bar">
      <div className="summary-totals" aria-label="Indicadores de las conversaciones visibles" aria-busy={waiting}>
        <div className="summary-stat-card"><span className="summary-stat-label">Conversaciones</span><strong>{metrics?.total.toLocaleString('es-HN') ?? '—'}</strong></div>
        <Tooltip trigger={['hover', 'focus']} placement="bottom" title={metrics ? countTooltip(metrics.withAlerts, metrics.total, 'con flags de atención') : null}>
          <div className="summary-stat-card summary-total-flags" tabIndex={metrics ? 0 : undefined} aria-label={`Con flags: ${flagPercentage}`}><span className="summary-stat-label">Con flags <InfoCircleOutlined aria-hidden="true" /></span><strong>{flagPercentage}</strong></div>
        </Tooltip>
        <Tooltip trigger={['hover', 'focus']} placement="bottom" title={metrics ? countTooltip(metrics.withPositives, metrics.total, 'con resultados positivos') : null}>
          <div className="summary-stat-card summary-total-positive" tabIndex={metrics ? 0 : undefined} aria-label={`Positivos: ${positivePercentage}`}><span className="summary-stat-label">+ Positivos <InfoCircleOutlined aria-hidden="true" /></span><strong>{positivePercentage}</strong></div>
        </Tooltip>
      </div>
      <div className="summary-range-actions">
        <Tooltip trigger={['hover', 'focus']} title="Cada chat aparece una vez, en el día de su última actividad registrada en Atom, aunque haya comenzado antes."><span className="summary-range" tabIndex={0}><CalendarOutlined /><span>{summaryRangeLabel(from, to)}</span></span></Tooltip>
        <Button type="text" size="small" aria-label="Actualizar resumen" title="Actualizar resumen" icon={<ReloadOutlined />} loading={loading} onClick={reload} />
      </div>
    </div>
    <ConfigProvider theme={{
      // Keep filter options above map tooltips so overlapping hints cannot intercept clicks.
      components: { Select: { zIndexPopup: 1100 } },
      ...(preset === 30 ? { token: { colorBgBase: '#f8fafc', colorBgContainer: '#ffffff', colorTextBase: '#243449', colorPrimary: '#5267a3', colorBorder: '#d5dde7', colorTextPlaceholder: '#69788a', controlHeight: 30 * fontScale } } : {}),
    }}><section className="overview-panel"><div className="summary-controls" aria-label="Filtros del resumen">
      <div className="summary-figures"><ExceptionsFilter kinds={figureKinds} selected={visible} onToggle={toggle} /><span className="summary-map-hint"><AppstoreOutlined />{preset === 30 ? 'Cada rectángulo es una conversación o grupo' : 'Cada rectángulo es una conversación'}</span></div>
      <div className="control-group summary-period"><span className="control-label">PERÍODO</span><div className="segmented-range">{SUMMARY_PRESETS.map(value => <button key={value} aria-pressed={preset === value} onClick={() => changeRange({ days: value })}>{value === 1 ? 'Hoy' : `${value} días`}</button>)}</div></div>
      <CountrySelect label="Países del resumen" countries={bootstrap.countries} value={countries} onChange={values => patchFilters({ countries: values.length ? values.sort().join(',') : null })} />
    </div>
      {error ? <ErrorState error={error} retry={reload} /> : waiting || !current ? <LoadingState /> : !metrics.total ? <div><EmptyState title={visible.length ? "Sin coincidencias" : "Ninguna excepción seleccionada"} description={visible.length ? "No hay conversaciones evaluadas que coincidan con el período y los filtros." : "Selecciona alguna excepción para mostrar conversaciones."} /><Button className="reset-figures" onClick={() => patchFilters({ figures: null })}>Restablecer excepciones</Button></div> : preset === 30 ? <CompactSummaryMap groups={groups} days={days} visible={visible} classification={classification} onOpen={open} onHistory={openHistory} /> : <div ref={mapRef} className="conversation-map" style={{ '--days': days.length }}><div className="map-scroll"><div className="map-head"><div className="map-name-head">PAÍS / ASISTENTE DE VENTA</div><div className="map-day-heads">{days.map((day, i) => <div key={day} className={i === 0 ? 'latest-day' : ''}><span title={dateText(day)}><>{i === 0 ? 'Hasta · ' : ''}{dateText(day, { year: undefined, weekday: 'short' })}</></span></div>)}</div></div>{groups.map(group => {
        return <section className="country-lanes" key={group.code}><div className="country-title"><button onClick={() => openHistory(group.code)}>{countryLabel(group.code, group.name)}<span className="country-code">{group.code}</span><RightOutlined /></button></div>{group.agents.map(agent => <div className="agent-lane" key={agent.id}><div className="lane-name" title={agent.name}><span className="agent-dot" /><span>{agent.name}</span></div><div className="lane-days">{days.map(day => <div className="day-cells" key={day}>{agent.byDay[day].map(c => {
          const marks = c.marks.filter(m => (visible.includes(markKind(m)) || visible.includes(classificationOf(m)) && m.effective) && (classification === 'all' || classificationOf(m) === classification));
          const kinds = [...new Set(marks.flatMap(m => m.kind === 'refuted' ? ['refuted'] : [classificationOf(m), ...(m.origin === 'human' || m.kind === 'human' ? ['human'] : [])]).filter(kind => visible.includes(kind)))];
          const agreed = dualMarks(c).filter(m => classification === 'all' || classificationOf(m) === classification);
          const status = evaluationStatus(c), pending = status !== 'evaluated';
          return <Tooltip key={c.id} title={<div className="conversation-tooltip"><b>{c.client.name}{c.client.phoneLast4 ? ` · …${c.client.phoneLast4}` : ''}</b><span>Última actividad: {dateText(c.displayDate, { year: undefined })} · {timeText(c.displayAt)} · {c.channel}</span><strong>{evaluationStatusLabel(c)}</strong><span>{marks.length ? marks.map(m => `${m.name}${m.kind === 'refuted' ? ' (refutado)' : ''}`).join(' · ') : c.evaluated ? noVisibleFlagsLabel(c) : 'Todavía no tiene resultados guardados'}</span>{c.unavailableFlags > 0 && <span>{c.unavailableFlags} variables sin datos o contexto suficientes</span>}{agreed.length > 0 && <strong>Detectado por ambos modelos: {agreed.map(m => m.name).join(' · ')}</strong>}</div>}><button className={`conversation-cell ${pending ? 'pending-cell' : ''} status-${status} ${agreed.length ? 'has-dual-detection' : ''}`} aria-label={`Abrir conversación de ${c.client.name}, ${agent.name}, ${day}, ${evaluationStatusLabel(c)}`} onClick={() => open(c)}>{kinds.map(kind => <Mark key={kind} kind={kind} small />)}</button></Tooltip>;
        })}</div>)}</div></div>)}</section>;
      })}</div></div>}</section></ConfigProvider>
  </div>;
}
