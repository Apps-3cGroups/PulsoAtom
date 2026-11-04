import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, DatePicker, Select, Tooltip } from 'antd';
import dayjs from 'dayjs';
import 'dayjs/locale/es';
import datePickerLocale from 'antd/es/date-picker/locale/es_ES';
import { ArrowRightOutlined, AppstoreOutlined, CalendarOutlined, LeftOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { PageHeading, LoadingState, ErrorState, EmptyState, Mark, PriorityTag, DualBadge, dateText, timeText } from '../components/common';
import { resolveSummaryRange, summaryDayWindow } from '../services/summaryDates';
import { classificationOf, flagCount, dualMarks, flagVariables, markKind } from '../services/flags';

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
  const [dayPage, setDayPage] = useState(1);
  const mapRef = useRef(null);
  const [country, setCountry] = useState();
  const [variable, setVariable] = useState();
  const [classification, setClassification] = useState('all');
  const [agreement, setAgreement] = useState('all');
  const [visible, setVisible] = useState(legends.map(([kind]) => kind));
  const { from, to, preset } = resolveSummaryRange({
    from: params.get('from'), to: params.get('to'), days: params.get('days'),
    latest: bootstrap.activityDateRange?.max || bootstrap.dateRange.max,
    mode: bootstrap.mode, timezone: bootstrap.timezone,
  });
  const summaryPath = `/summary?${queryString({ from, to, country, variable, classification, agreement, dateBasis: 'activity' })}`;
  const { data, dataPath, loading, error, reload } = useApi(summaryPath);
  const waiting = loading || dataPath !== summaryPath;
  const current = !waiting && !error ? data : null;
  const window = useMemo(() => summaryDayWindow({ from, to, page: dayPage }), [from, to, dayPage]);
  const { days } = window;
  useEffect(() => { setDayPage(1); mapRef.current?.scrollTo(0, 0); }, [from, to]);
  const changeRange = values => {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      ['from', 'to', 'days'].forEach(key => next.delete(key));
      for (const [key, value] of Object.entries(values)) next.set(key, String(value));
      return next;
    }, { replace: true });
  };
  const changePage = page => { setDayPage(page); mapRef.current?.scrollTo(0, 0); };
  const open = c => navigate(`/conversacion/${encodeURIComponent(c.id)}`);
  const openHistory = code => navigate(`/historico?${queryString({ from, to, country: code, dateBasis: 'activity' })}`);
  const toggle = kind => setVisible(current => current.includes(kind) ? current.filter(v => v !== kind) : [...current, kind]);
  const metrics = current?.metrics;
  const groups = bootstrap.countries.filter(c => !country || country === c.code);
  return <div className="summary-page">
    <PageHeading eyebrow="VISIÓN REGIONAL" title="Resumen de conversaciones" description="Identifica lo que requiere atención y explora la evidencia." actions={<div className="summary-heading-actions">
      <div className="period-note"><CalendarOutlined /><span>{dateText(from)} — {dateText(to)}</span><Tooltip title="Actualizar resumen"><Button type="text" size="small" aria-label="Actualizar resumen" icon={<ReloadOutlined />} disabled={loading} onClick={reload} /></Tooltip></div>
      <Tooltip title="Cada chat aparece una vez, en el día de su última actividad registrada en Atom, aunque haya comenzado antes."><span className="small muted">Por última actividad</span></Tooltip>
    </div>} />
    <div className="metrics-grid" aria-busy={waiting}>
      <Metric value={metrics?.total.toLocaleString('es-HN') ?? '—'} label="Conversaciones" detail={metrics ? `${metrics.evaluated} con resultados · ${metrics.pending} sin evaluar${current.conversations.some(c => c.evaluationIncomplete) ? ` · ${current.conversations.filter(c => c.evaluationIncomplete).length} parciales` : ''}` : waiting ? 'Consultando período…' : 'Sin datos disponibles'} />
      <Metric value={metrics?.alertPercent == null ? '—' : `${metrics.alertPercent}%`} label="Con flags de atención" detail={metrics ? `${metrics.withAlerts} conversaciones con flags vigentes` : 'Resultados del período'} accent title="Conversaciones evaluadas con al menos un flag crítico o normal vigente, del sistema o humano, divididas entre conversaciones evaluadas del período." />
      <Metric value={metrics?.refutedPercent == null ? '—' : `${metrics.refutedPercent}%`} label="Alertas refutadas" detail={metrics ? `${metrics.refuted} de ${metrics.originalAlerts} alertas del sistema` : 'Revisiones del período'} title="Flags críticos o normales del sistema refutados por un supervisor, divididos entre todos los flags críticos o normales originales del sistema en el período." />
      <Metric value={metrics?.human ?? '—'} label="Levantadas por humanos" detail="Eventos detectados en la revisión" />
      <Metric value={metrics?.withPositives ?? '—'} label="+ Con positivos" detail="Conversaciones con buenos resultados" positive />
    </div>
    <section className="overview-panel"><div className="overview-header"><div><div className="eyebrow">MAPA DE CONVERSACIONES</div><h2>La atención, en perspectiva</h2></div><span className="muted small"><AppstoreOutlined /> Cada rectángulo es una conversación</span></div><div className="overview-controls">
      <div className="control-group"><span className="control-label">PERÍODO</span><div className="segmented-range">{[1, 4, 7, 14, 30].map(value => <button key={value} aria-pressed={preset === value} onClick={() => changeRange({ days: value })}>{value === 1 ? bootstrap.mode === 'demo' ? 'Último día' : 'Hoy' : `${value} días`}</button>)}</div></div>
      <div className="summary-date-range">
        <label className="visually-hidden" htmlFor="summary-date-from">Fecha inicial del resumen</label><label className="visually-hidden" htmlFor="summary-date-to">Fecha final del resumen</label>
        <DatePicker.RangePicker id={{ start: 'summary-date-from', end: 'summary-date-to' }} locale={datePickerLocale} format="DD/MM/YYYY" value={[dayjs(from).year(Number(from.slice(0, 4))).locale('es'), dayjs(to).year(Number(to.slice(0, 4))).locale('es')]} placeholder={['Desde', 'Hasta']} allowClear onChange={dates => changeRange(dates ? { from: dates[0].format('YYYY-MM-DD'), to: dates[1].format('YYYY-MM-DD') } : { days: 7 })} />
      </div>
      <Select aria-label="País del resumen" value={country || 'all'} onChange={value => setCountry(value === 'all' ? undefined : value)} options={[{ label: 'Todos los países', value: 'all' }, ...bootstrap.countries.map(c => ({ label: c.name, value: c.code }))]} style={{ minWidth: 170 }} />
      <Select aria-label="Variable visible en el mapa" value={variable || 'all'} onChange={value => setVariable(value === 'all' ? undefined : value)} showSearch optionFilterProp="label" options={variableOptions(bootstrap.catalog)} className="map-variable" classNames={{ popup: { root: 'summary-variable-menu' } }} />
    </div><div className="map-legend"><span className="control-label">FIGURAS VISIBLES</span>{legends.map(([kind, label]) => <button key={kind} className={`legend-toggle ${visible.includes(kind) ? 'selected' : ''}`} aria-pressed={visible.includes(kind)} onClick={() => toggle(kind)}><Mark kind={kind} />{label}</button>)}<Select size="small" aria-label="Clasificación del resumen" value={classification} onChange={setClassification} options={[{ value: 'all', label: 'Todos los flags' }, { value: 'critical', label: 'Críticos' }, { value: 'normal', label: 'Normales' }, { value: 'positive', label: '+ Positivos' }]} /><button className={`legend-toggle dual-toggle ${agreement === 'both' ? 'selected' : ''}`} aria-pressed={agreement === 'both'} onClick={() => setAgreement(agreement === 'both' ? 'all' : 'both')}><DualBadge compact />Detectado por ambos</button><Tooltip title="El borde discontinuo y ? indican evaluación pendiente o parcial. Consulta el detalle para conocer qué falta."><span className="not-evaluated-legend"><i>?</i>Pendiente / parcial</span></Tooltip></div>
      {error ? <ErrorState error={error} retry={reload} /> : waiting || !current ? <LoadingState /> : !metrics.total ? <EmptyState description="No hay conversaciones cuya última actividad esté en este período. Prueba otras fechas o ajusta los filtros." /> : <div ref={mapRef} className="conversation-map" style={{ '--days': days.length }}><div className="map-scroll"><div className="map-head"><div className="map-name-head">PAÍS / ASISTENTE DE VENTA</div><div className="map-day-heads">{days.map((day, i) => <div key={day} className={i === 0 ? 'latest-day' : ''}>{i === 0 && window.page === 1 ? <><span className="status-dot" />Hasta · </> : null}{dateText(day, { year: undefined, weekday: 'short' })}</div>)}</div></div>{groups.map(group => {
        const convs = current.conversations.filter(c => c.country === group.code);
        if (!convs.length) return null;
        const agents = [...new Map(convs.map(c => [c.agent.id, c.agent])).values()];
        return <section className="country-lanes" key={group.code}><div className="country-title"><button onClick={() => openHistory(group.code)}>{group.name}<span className="country-code">{group.code}</span><RightOutlined /></button><div>{['critical', 'normal', 'positive'].map(kind => { const count = convs.reduce((n, c) => n + flagCount(c, kind), 0); return count > 0 ? <PriorityTag key={kind} priority={kind} count={count} /> : null; })}</div></div>{agents.map(agent => <div className="agent-lane" key={agent.id}><div className="lane-name"><span className="agent-dot" />{agent.name}<span className="lane-volume">{convs.filter(c => c.agent.id === agent.id).length}</span></div><div className="lane-days">{days.map(day => <div className="day-cells" key={day}>{convs.filter(c => c.agent.id === agent.id && c.displayDate === day).sort((a, b) => b.displayAt.localeCompare(a.displayAt)).map(c => {
          const marks = c.marks.filter(m => (visible.includes(markKind(m)) || visible.includes(classificationOf(m)) && m.effective) && (!variable || m.id === variable) && (classification === 'all' || classificationOf(m) === classification));
          const kinds = [...new Set(marks.flatMap(m => m.kind === 'refuted' ? ['refuted'] : [classificationOf(m), ...(m.origin === 'human' || m.kind === 'human' ? ['human'] : [])]).filter(kind => visible.includes(kind)))];
          const agreed = dualMarks(c, variable).filter(m => classification === 'all' || classificationOf(m) === classification);
          return <Tooltip key={c.id} title={<div className="conversation-tooltip"><b>{c.client.name}{c.client.phoneLast4 ? ` · …${c.client.phoneLast4}` : ''}</b><span>Última actividad: {dateText(c.displayDate, { year: undefined })} · {timeText(c.displayAt)} · {c.channel}</span><span>{!c.evaluated ? 'No evaluada' : marks.length ? marks.map(m => `${m.name}${m.kind === 'refuted' ? ' (refutado)' : ''}`).join(' · ') : c.evaluationIncomplete ? 'Hay resultados pendientes' : 'Sin flags visibles'}</span>{c.evaluationIncomplete && <strong>Evaluación parcial · {c.pendingFlags} flags pendientes de resultado</strong>}{agreed.length > 0 && <strong>Detectado por ambos modelos: {agreed.map(m => m.name).join(' · ')}</strong>}</div>}><button className={`conversation-cell ${!c.evaluated || c.evaluationIncomplete ? 'pending-cell' : ''} ${agreed.length ? 'has-dual-detection' : ''}`} style={{ width: `${Math.max(31, kinds.length * 11 + (agreed.length ? 17 : 0) + (c.evaluationIncomplete ? 12 : 0) + 8)}px` }} aria-label={`Abrir conversación de ${c.client.name}, ${agent.name}, ${day}, ${c.evaluated ? `${flagCount(c, 'critical')} críticos, ${flagCount(c, 'normal')} normales y ${flagCount(c, 'positive')} positivos${agreed.length ? ', detectado por ambos modelos' : ''}${c.evaluationIncomplete ? `, evaluación parcial: ${c.pendingFlags} flags pendientes` : ''}` : 'no evaluada'}`} onClick={() => open(c)}>{!c.evaluated ? <span>?</span> : kinds.map(kind => <Mark key={kind} kind={kind} small />)}{c.evaluated && c.evaluationIncomplete && <span className="partial-indicator" aria-label="Evaluación parcial">?</span>}{agreed.length > 0 && <DualBadge compact />}</button></Tooltip>;
        })}</div>)}</div></div>)}</section>;
      })}</div></div>}<div className="map-footer"><span><span className="mini-rectangle" />Sin flags en las variables evaluadas</span>{window.pageCount > 1 && <div className="map-date-pages"><Button size="small" type="text" aria-label="Ver días más recientes" icon={<LeftOutlined />} disabled={window.page === 1 || waiting} onClick={() => changePage(window.page - 1)} /><span>{dateText(days.at(-1), { year: undefined })} — {dateText(days[0], { year: undefined })} · {window.page}/{window.pageCount}</span><Button size="small" type="text" aria-label="Ver días anteriores" icon={<RightOutlined />} disabled={window.page === window.pageCount || waiting} onClick={() => changePage(window.page + 1)} /></div>}<span>Más reciente a la izquierda <ArrowRightOutlined /> más antiguo</span></div></section>
  </div>;
}
function Metric({ value, label, detail, accent, positive, title }) { return <Tooltip title={title}><div className={`metric-card ${accent ? 'metric-attention' : ''} ${positive ? 'metric-positive' : ''}`}><div className="metric-label">{label}{accent && <span className="attention-dot" />}</div><strong>{value}</strong><div className="metric-detail">{detail}</div></div></Tooltip>; }
