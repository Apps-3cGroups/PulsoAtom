import { conversationLink } from '../services/conversationNavigation';
import { selectedCountries, selectedFigures, selectedPending, filterSummaryConversations, summaryMetrics } from '../services/summaryFilters';
import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Checkbox, ConfigProvider, Select, Tooltip } from 'antd';
import { ArrowRightOutlined, AppstoreOutlined, CalendarOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { LoadingState, ErrorState, EmptyState, Mark, dateText, timeText } from '../components/common';
import { resolveSummaryRange, summaryDayWindow, SUMMARY_PRESETS } from '../services/summaryDates';
import { summaryRangeLabel } from '../services/summaryPresentation';
import { buildSummaryLanes } from '../services/summaryMap';
import CompactSummaryMap from '../components/CompactSummaryMap';
import { classificationOf, dualMarks, flagVariables, markKind, noVisibleFlagsLabel, evaluationStatus, evaluationStatusLabel } from '../services/flags';
import './Summary.css';

const legends = [['critical', 'Crítico'], ['normal', 'Menor'], ['positive', 'Positivo'], ['refuted', 'Refutado'], ['human', 'Humano']];
const variableOptions = catalog => [
  { label: 'Todas las variables', value: 'all' },
  ...[
    ['Críticos', variable => classificationOf(variable) === 'critical'],
    ['Menores', variable => classificationOf(variable) === 'normal'],
    ['Positivos', variable => classificationOf(variable) === 'positive'],
  ].map(([label, predicate]) => ({
    label: <span className={`variable-group-heading group-${label.toLowerCase()}`}><span className="variable-group-dot" aria-hidden="true" />{label}</span>,
    options: flagVariables(catalog).filter(predicate).map(variable => ({ label: variable.name, value: variable.id })),
  })).filter(group => group.options.length),
];
export default function Summary() {
  const { bootstrap } = usePortal();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const mapRef = useRef(null);
  const countries = selectedCountries(params, bootstrap.countries);
  const variable = params.get('variable') || undefined;
  const classification = 'all';
  const visible = selectedFigures(params);
  const showPending = selectedPending(params);
  const patchFilters = values => setParams(previous => {
    const next = new URLSearchParams(previous);
    if (!next.has('countries') && next.has('country')) next.set('countries', next.get('country'));
    ['country', 'classification', 'agreement'].forEach(key => next.delete(key));
    for (const [key, value] of Object.entries(values)) value == null ? next.delete(key) : next.set(key, value);
    return next;
  });
  const { from, to, preset } = resolveSummaryRange({
    days: params.get('days'),
    latest: bootstrap.activityDateRange?.max || bootstrap.dateRange.max,
    mode: bootstrap.mode, timezone: bootstrap.timezone,
  });
  const summaryPath = `/summary?${queryString({ from, to, countries: countries.join(','), variable, dateBasis: 'activity' })}`;
  const { data, dataPath, loading, error, reload } = useApi(summaryPath, { timeoutMs: 60000 });
  const waiting = loading || dataPath !== summaryPath;
  const current = !waiting && !error ? data : null;
  const window = useMemo(() => summaryDayWindow({ from, to }), [from, to]);
  const { days } = window;
  useEffect(() => { mapRef.current?.scrollTo(0, 0); }, [from, to]);
  const changeRange = values => {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      ['from', 'to', 'days'].forEach(key => next.delete(key));
      for (const [key, value] of Object.entries(values)) next.set(key, String(value));
      return next;
    }, { replace: true });
  };
  const open = c => navigate(conversationLink(c.id, `${location.pathname}${location.search}`));
  const openHistory = code => navigate(`/historico?${queryString({ from, to, country: code, dateBasis: 'activity' })}`);
  const toggle = kind => patchFilters({ figures: (visible.includes(kind) ? visible.filter(v => v !== kind) : [...visible, kind]).join(',') });
  const filtered = useMemo(() => filterSummaryConversations(current?.conversations || [], visible, variable, { showPending }), [current, visible.join(','), variable, showPending]);
  const hiddenPending = !showPending ? filterSummaryConversations(current?.conversations || [], visible, variable, { showPending: true }).length - filtered.length : 0;
  const metrics = current ? summaryMetrics(filtered) : null;
  const groups = useMemo(() => buildSummaryLanes(filtered, bootstrap.countries, days), [filtered, bootstrap.countries, days]);
  return <div className={`summary-page ${preset === 30 ? 'summary-month' : ''}`}>
    <h1 className="visually-hidden">Resumen de conversaciones</h1>
    <div className="summary-stats-bar">
      <div className="summary-totals" aria-label="Indicadores de las conversaciones visibles" aria-busy={waiting}>
        <div className="summary-stat-card"><span>Conversaciones</span><strong>{metrics?.total.toLocaleString('es-HN') ?? '—'}</strong></div>
        <div className="summary-stat-card summary-total-flags"><span>Con flags</span><strong>{metrics?.withAlerts.toLocaleString('es-HN') ?? '—'}</strong></div>
        <div className="summary-stat-card summary-total-positive"><span>Con positivos</span><strong>{metrics?.withPositives.toLocaleString('es-HN') ?? '—'}</strong></div>
      </div>
      <div className="summary-range-actions">
        <Tooltip trigger={['hover', 'focus']} title="Cada chat aparece una vez, en el día de su última actividad registrada en Atom, aunque haya comenzado antes."><span className="summary-range" tabIndex={0}><CalendarOutlined /><span>{summaryRangeLabel(from, to)}</span></span></Tooltip>
        <Button type="text" size="small" aria-label="Actualizar resumen" title="Actualizar resumen" icon={<ReloadOutlined />} loading={loading} onClick={reload} />
      </div>
    </div>
    <ConfigProvider theme={{
      // Keep filter options above map tooltips so overlapping hints cannot intercept clicks.
      components: { Select: { zIndexPopup: 1100 } },
      ...(preset === 30 ? { token: { colorBgBase: '#f8fafc', colorBgContainer: '#ffffff', colorTextBase: '#243449', colorPrimary: '#5267a3', colorBorder: '#d5dde7', colorTextPlaceholder: '#69788a', controlHeight: 30 } } : {}),
    }}><section className="overview-panel"><div className="summary-controls" aria-label="Filtros del resumen">
      <div className="summary-figures"><span className="control-label">FIGURAS VISIBLES</span>{legends.map(([kind, label]) => <button key={kind} className={`legend-toggle ${visible.includes(kind) ? 'selected' : ''}`} aria-pressed={visible.includes(kind)} onClick={() => toggle(kind)}><Mark kind={kind} />{label}</button>)}<span className="summary-map-hint"><AppstoreOutlined />{preset === 30 ? 'Cada rectángulo es una conversación o grupo' : 'Cada rectángulo es una conversación'}</span></div>
      <div className="control-group summary-period"><span className="control-label">PERÍODO</span><div className="segmented-range">{SUMMARY_PRESETS.map(value => <button key={value} aria-pressed={preset === value} onClick={() => changeRange({ days: value })}>{value === 1 ? 'Hoy' : `${value} días`}</button>)}</div></div>
      <Select mode="multiple" maxTagCount="responsive" allowClear showSearch optionFilterProp="label" aria-label="Países del resumen" placeholder="Todos los países" value={countries} onChange={values => patchFilters({ countries: values.length ? values.sort().join(',') : null })} options={bootstrap.countries.map(c => ({ label: c.name, value: c.code }))} className="country-multiselect" />
      <Select aria-label="Variable visible en el mapa" value={variable || 'all'} onChange={value => patchFilters({ variable: value === 'all' ? null : value })} showSearch optionFilterProp="label" options={variableOptions(bootstrap.catalog)} className="map-variable" classNames={{ popup: { root: 'summary-variable-menu' } }} />
      <Tooltip title="Incluye conversaciones sin evaluar o pendientes de la revisión de un modelo. Las evaluadas con incidencias siguen visibles; el borde discontinuo conserva esa distinción."><Checkbox className="summary-pending-toggle" checked={showPending} onChange={event => patchFilters({ pending: event.target.checked ? '1' : null })}>Mostrar pendientes</Checkbox></Tooltip>
    </div>
      {error ? <ErrorState error={error} retry={reload} /> : waiting || !current ? <LoadingState /> : !metrics.total ? <div><EmptyState title={visible.length ? "Sin coincidencias" : "Ninguna figura seleccionada"} description={visible.length ? hiddenPending ? `Hay ${hiddenPending} conversaciones pendientes ocultas en esta selección.` : "No hay conversaciones que coincidan con el período y los filtros." : "Selecciona alguna figura para mostrar conversaciones."} />{hiddenPending ? <Button className="reset-figures" onClick={() => patchFilters({ pending: '1' })}>Mostrar pendientes</Button> : <Button className="reset-figures" onClick={() => patchFilters({ figures: null })}>Restablecer figuras</Button>}</div> : preset === 30 ? <CompactSummaryMap groups={groups} days={days} visible={visible} variable={variable} classification={classification} onOpen={open} onHistory={openHistory} /> : <div ref={mapRef} className="conversation-map" style={{ '--days': days.length }}><div className="map-scroll"><div className="map-head"><div className="map-name-head">PAÍS / ASISTENTE DE VENTA</div><div className="map-day-heads">{days.map((day, i) => <div key={day} className={i === 0 ? 'latest-day' : ''}><span title={dateText(day)}><>{i === 0 ? 'Hasta · ' : ''}{dateText(day, { year: undefined, weekday: 'short' })}</></span></div>)}</div></div>{groups.map(group => {
        return <section className="country-lanes" key={group.code}><div className="country-title"><button onClick={() => openHistory(group.code)}>{group.name}<span className="country-code">{group.code}</span><RightOutlined /></button></div>{group.agents.map(agent => <div className="agent-lane" key={agent.id}><div className="lane-name" title={agent.name}><span className="agent-dot" /><span>{agent.name}</span></div><div className="lane-days">{days.map(day => <div className="day-cells" key={day}>{agent.byDay[day].map(c => {
          const marks = c.marks.filter(m => (visible.includes(markKind(m)) || visible.includes(classificationOf(m)) && m.effective) && (!variable || m.id === variable) && (classification === 'all' || classificationOf(m) === classification));
          const kinds = [...new Set(marks.flatMap(m => m.kind === 'refuted' ? ['refuted'] : [classificationOf(m), ...(m.origin === 'human' || m.kind === 'human' ? ['human'] : [])]).filter(kind => visible.includes(kind)))];
          const agreed = dualMarks(c, variable).filter(m => classification === 'all' || classificationOf(m) === classification);
          const status = evaluationStatus(c), pending = status !== 'evaluated';
          return <Tooltip key={c.id} title={<div className="conversation-tooltip"><b>{c.client.name}{c.client.phoneLast4 ? ` · …${c.client.phoneLast4}` : ''}</b><span>Última actividad: {dateText(c.displayDate, { year: undefined })} · {timeText(c.displayAt)} · {c.channel}</span><strong>{evaluationStatusLabel(c)}</strong><span>{marks.length ? marks.map(m => `${m.name}${m.kind === 'refuted' ? ' (refutado)' : ''}`).join(' · ') : c.evaluated ? noVisibleFlagsLabel(c) : 'Todavía no tiene resultados guardados'}</span>{c.unavailableFlags > 0 && <span>{c.unavailableFlags} variables sin datos o contexto suficientes</span>}{agreed.length > 0 && <strong>Detectado por ambos modelos: {agreed.map(m => m.name).join(' · ')}</strong>}</div>}><button className={`conversation-cell ${pending ? 'pending-cell' : ''} status-${status} ${agreed.length ? 'has-dual-detection' : ''}`} aria-label={`Abrir conversación de ${c.client.name}, ${agent.name}, ${day}, ${evaluationStatusLabel(c)}`} onClick={() => open(c)}>{kinds.map(kind => <Mark key={kind} kind={kind} small />)}</button></Tooltip>;
        })}</div>)}</div></div>)}</section>;
      })}</div></div>}<div className="map-footer"><span><span className="mini-rectangle" />{preset === 30 ? 'Sin flags visibles · las celdas densas se agrupan; pulsa para ver el detalle' : 'Sin flags visibles · consulta el detalle'}</span><span>Más reciente a la izquierda <ArrowRightOutlined /> más antiguo</span></div></section></ConfigProvider>
  </div>;
}
