import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, ConfigProvider, Select, Tooltip } from 'antd';
import { ArrowRightOutlined, AppstoreOutlined, CalendarOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { PageHeading, LoadingState, ErrorState, EmptyState, Mark, DualBadge, dateText, timeText } from '../components/common';
import { resolveSummaryRange, summaryDayWindow, SUMMARY_PRESETS } from '../services/summaryDates';
import { buildSummaryLanes } from '../services/summaryMap';
import CompactSummaryMap from '../components/CompactSummaryMap';
import { classificationOf, dualMarks, flagVariables, markKind, noVisibleFlagsLabel, evaluationStatus, evaluationStatusLabel, evaluationCoverage } from '../services/flags';

const legends = [['critical', 'Crítico'], ['normal', 'Normal'], ['positive', 'Positivo'], ['refuted', 'Refutado'], ['human', 'Humano']];
const variableOptions = catalog => [
  { label: 'Todas las variables', value: 'all' },
  ...[
    ['Críticos', variable => classificationOf(variable) === 'critical'],
    ['Normales', variable => classificationOf(variable) === 'normal'],
    ['Positivos', variable => classificationOf(variable) === 'positive'],
  ].map(([label, predicate]) => ({
    label: <span className={`variable-group-heading group-${label.toLowerCase()}`}><span className="variable-group-dot" aria-hidden="true" />{label}</span>,
    options: flagVariables(catalog).filter(predicate).map(variable => ({ label: variable.name, value: variable.id })),
  })).filter(group => group.options.length),
];
export default function Summary() {
  const { bootstrap } = usePortal();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const mapRef = useRef(null);
  const [country, setCountry] = useState();
  const [variable, setVariable] = useState();
  const [classification, setClassification] = useState('all');
  const [agreement, setAgreement] = useState('all');
  const [visible, setVisible] = useState(legends.map(([kind]) => kind));
  const { from, to, preset } = resolveSummaryRange({
    days: params.get('days'),
    latest: bootstrap.activityDateRange?.max || bootstrap.dateRange.max,
    mode: bootstrap.mode, timezone: bootstrap.timezone,
  });
  const summaryPath = `/summary?${queryString({ from, to, country, variable, classification, agreement, dateBasis: 'activity' })}`;
  const { data, dataPath, loading, error, reload } = useApi(summaryPath);
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
  const open = c => navigate(`/conversacion/${encodeURIComponent(c.id)}`);
  const openHistory = code => navigate(`/historico?${queryString({ from, to, country: code, dateBasis: 'activity' })}`);
  const toggle = kind => setVisible(current => current.includes(kind) ? current.filter(v => v !== kind) : [...current, kind]);
  const metrics = current?.metrics;
  const coverage = evaluationCoverage(current?.conversations || []);
  const groups = useMemo(() => buildSummaryLanes(current?.conversations || [], bootstrap.countries, days), [current, bootstrap.countries, days]);
  return <div className={`summary-page ${preset === 30 ? 'summary-month' : ''}`}>
    <PageHeading eyebrow="VISIÓN REGIONAL" title="Resumen de conversaciones" description="Flags automáticos con coincidencia de ambos modelos y revisiones humanas." actions={<div className="summary-heading-actions">
      <div className="period-note"><CalendarOutlined /><span>{dateText(from)} — {dateText(to)}</span><Tooltip title="Actualizar resumen"><Button type="text" size="small" aria-label="Actualizar resumen" icon={<ReloadOutlined />} disabled={loading} onClick={reload} /></Tooltip></div>
      <Tooltip title="Cada chat aparece una vez, en el día de su última actividad registrada en Atom, aunque haya comenzado antes."><span className="small muted">Por última actividad</span></Tooltip>
    </div>} />
    <div className="metrics-grid" aria-busy={waiting}>
      <Metric value={metrics?.total.toLocaleString('es-HN') ?? '—'} label="Conversaciones" detail={metrics ? `${metrics.evaluated} con resultados · ${metrics.pending} sin evaluar` : waiting ? 'Consultando período…' : 'Sin datos disponibles'} title={`${coverage.evaluated} evaluadas · ${coverage.review_pending} por completar con ambos modelos · ${coverage.partial} evaluadas con incidencias. Las variables sin datos suficientes no indican una ejecución pendiente.`} />
      <Metric value={metrics?.alertPercent == null ? '—' : `${metrics.alertPercent}%`} label="Con flags de atención" detail={metrics ? `${metrics.withAlerts} conversaciones con flags vigentes` : 'Resultados del período'} accent title="Conversaciones evaluadas con al menos un flag crítico o normal vigente, de la IA o de una revisión humana, divididas entre conversaciones evaluadas del período." />
      <Metric value={metrics?.refutedPercent == null ? '—' : `${metrics.refutedPercent}%`} label="Alertas refutadas" detail={metrics ? 'Revisiones sobre alertas detectadas por IA' : 'Revisiones del período'} title="Refutaciones sobre flags automáticos con doble detección más refutaciones históricas conservadas. No incluye detecciones individuales." />
      <Metric value={current ? current.conversations.filter(c => c.human > 0).length : '—'} label="Con revisión humana" detail="Conversaciones con flags humanos" />
      <Metric value={metrics?.withPositives ?? '—'} label="+ Con positivos" detail="Conversaciones con buenos resultados" positive />
    </div>
    <ConfigProvider theme={preset === 30 ? { token: { colorBgBase: '#f8fafc', colorBgContainer: '#ffffff', colorTextBase: '#243449', colorPrimary: '#5267a3', colorBorder: '#d5dde7', colorTextPlaceholder: '#69788a', controlHeight: 30 } } : undefined}><section className="overview-panel"><div className="overview-header"><div><div className="eyebrow">MAPA DE CONVERSACIONES</div><h2>La atención, en perspectiva</h2></div><span className="muted small"><AppstoreOutlined /> Cada rectángulo es una conversación</span></div><div className="overview-controls">
      <div className="control-group"><span className="control-label">PERÍODO</span><div className="segmented-range">{SUMMARY_PRESETS.map(value => <button key={value} aria-pressed={preset === value} onClick={() => changeRange({ days: value })}>{value === 1 ? 'Hoy' : `${value} días`}</button>)}</div></div>
      <Select aria-label="País del resumen" value={country || 'all'} onChange={value => setCountry(value === 'all' ? undefined : value)} options={[{ label: 'Todos los países', value: 'all' }, ...bootstrap.countries.map(c => ({ label: c.name, value: c.code }))]} style={{ minWidth: 170 }} />
      <Select aria-label="Variable visible en el mapa" value={variable || 'all'} onChange={value => setVariable(value === 'all' ? undefined : value)} showSearch optionFilterProp="label" options={variableOptions(bootstrap.catalog)} className="map-variable" classNames={{ popup: { root: 'summary-variable-menu' } }} />
    </div><div className="map-legend"><span className="control-label">FIGURAS VISIBLES</span>{legends.map(([kind, label]) => <button key={kind} className={`legend-toggle ${visible.includes(kind) ? 'selected' : ''}`} aria-pressed={visible.includes(kind)} onClick={() => toggle(kind)}><Mark kind={kind} />{label}</button>)}<Select size="small" aria-label="Clasificación del resumen" value={classification} onChange={setClassification} options={[{ value: 'all', label: 'Todos los flags' }, { value: 'critical', label: 'Críticos' }, { value: 'normal', label: 'Normales' }, { value: 'positive', label: '+ Positivos' }]} /><button className={`legend-toggle dual-toggle ${agreement === 'both' ? 'selected' : ''}`} aria-pressed={agreement === 'both'} onClick={() => setAgreement(agreement === 'both' ? 'all' : 'both')}><DualBadge compact />Detectado por ambos</button><Tooltip title="El borde discontinuo señala falta de evaluación, revisión pendiente o incidencias. El detalle conserva el estado y los resultados de ambos modelos."><span className="not-evaluated-legend"><i aria-hidden="true" />Pendiente / parcial</span></Tooltip></div>
      {error ? <ErrorState error={error} retry={reload} /> : waiting || !current ? <LoadingState /> : !metrics.total ? <EmptyState description="No hay conversaciones cuya última actividad esté en este período. Prueba otro período o ajusta los filtros." /> : preset === 30 ? <CompactSummaryMap groups={groups} days={days} visible={visible} variable={variable} classification={classification} onOpen={open} onHistory={openHistory} /> : <div ref={mapRef} className="conversation-map" style={{ '--days': days.length }}><div className="map-scroll"><div className="map-head"><div className="map-name-head">PAÍS / ASISTENTE DE VENTA</div><div className="map-day-heads">{days.map((day, i) => <div key={day} className={i === 0 ? 'latest-day' : ''}><span title={dateText(day)}><>{i === 0 ? 'Hasta · ' : ''}{dateText(day, { year: undefined, weekday: 'short' })}</></span></div>)}</div></div>{groups.map(group => {
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
function Metric({ value, label, detail, accent, positive, title }) { return <Tooltip title={title}><div className={`metric-card ${accent ? 'metric-attention' : ''} ${positive ? 'metric-positive' : ''}`}><div className="metric-label">{label}{accent && <span className="attention-dot" />}</div><strong>{value}</strong><div className="metric-detail">{detail}</div></div></Tooltip>; }
