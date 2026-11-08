import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Select, Tooltip } from 'antd';
import { ArrowRightOutlined, AppstoreOutlined, CalendarOutlined, RightOutlined, ClockCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { PageHeading, LoadingState, ErrorState, EmptyState, Mark, PriorityTag, DualBadge, dateText, timeText, previousDate } from '../components/common';
import { defaultDateRange } from '../services/dateRange';
import { classificationOf, flagCount, dualMarks, flagVariables, markKind, noVisibleFlagsLabel, evaluationStatus, evaluationStatusLabel, evaluationCoverage } from '../services/flags';

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
  const [range, setRange] = useState(7);
  const [country, setCountry] = useState();
  const [variable, setVariable] = useState();
  const [classification, setClassification] = useState('all');
  const [agreement, setAgreement] = useState('all');
  const [visible, setVisible] = useState(legends.map(([kind]) => kind));
  const latest = bootstrap.dateRange.max;
  const { to } = defaultDateRange(latest, bootstrap.timezone);
  const from = previousDate(to, range - 1);
  const summaryPath = `/summary?${queryString({ from, to, country, variable, classification, agreement })}`;
  const { data, dataPath, error, reload } = useApi(summaryPath);
  const days = useMemo(() => Array.from({ length: range }, (_, i) => previousDate(to, i)), [to, range]);
  const open = c => navigate(`/conversacion/${encodeURIComponent(c.id)}`);
  const openHistory = code => navigate(`/historico?${queryString({ from, to, country: code })}`);
  const toggle = kind => setVisible(current => current.includes(kind) ? current.filter(v => v !== kind) : [...current, kind]);
  const metrics = data?.metrics;
  const coverage = evaluationCoverage(data?.conversations || []);
  const groups = bootstrap.countries.filter(c => !country || country === c.code);
  return <div className="summary-page"><PageHeading eyebrow="VISIÓN REGIONAL" title="Resumen de conversaciones" description="Flags automáticos con coincidencia de ambos modelos y revisiones humanas." actions={<div className="summary-heading-actions"><div className="period-note"><CalendarOutlined /><span>{latest ? `${dateText(from)} — ${dateText(to)}` : 'Sin datos cargados'}</span></div></div>} />{error ? <ErrorState error={error} retry={reload} /> : !data || dataPath !== summaryPath ? <LoadingState /> : <>
    <div className="metrics-grid">
      <Metric value={metrics.total.toLocaleString('es-HN')} label="Conversaciones" detail={`${metrics.evaluated} con resultados · ${metrics.pending} sin evaluar`} title={`${coverage.evaluated} evaluadas · ${coverage.review_pending} por completar con ambos modelos · ${coverage.partial} evaluadas con incidencias. Las variables sin datos suficientes no indican una ejecución pendiente.`} />
      <Metric value={metrics.alertPercent === null ? '—' : `${metrics.alertPercent}%`} label="Con flags de atención" detail={`${metrics.withAlerts} conversaciones con flags vigentes`} accent title="Conversaciones evaluadas con al menos un flag crítico o normal vigente, del sistema o humano, divididas entre conversaciones evaluadas del período." />
      <Metric value={metrics.refutedPercent === null ? '—' : `${metrics.refutedPercent}%`} label="Alertas refutadas" detail={`${metrics.refuted} de ${metrics.originalAlerts} alertas consideradas`} title="Refutaciones de flags críticos o normales sobre el total de flags automáticos con doble detección más las refutaciones históricas conservadas. No incluye otras detecciones individuales." />
      <Metric value={metrics.human} label="Levantadas por humanos" detail="Eventos detectados en la revisión" />
      <Metric value={metrics.withPositives ?? data.conversations.filter(c => flagCount(c, 'positive') > 0).length} label="+ Con positivos" detail="Conversaciones con buenos resultados" positive />
    </div>
    <section className="overview-panel"><div className="overview-header"><div><div className="eyebrow">MAPA DE CONVERSACIONES</div><h2>La atención, en perspectiva</h2></div><span className="muted small"><AppstoreOutlined /> Cada rectángulo es una conversación</span></div><div className="overview-controls"><div className="control-group"><span className="control-label">PERÍODO</span><div className="segmented-range">{[1, 4, 7, 14, 30].map(value => <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{value === 1 ? 'Último día' : `${value} días`}</button>)}</div></div><Select aria-label="País del resumen" value={country || 'all'} onChange={value => setCountry(value === 'all' ? undefined : value)} options={[{ label: 'Todos los países', value: 'all' }, ...bootstrap.countries.map(c => ({ label: c.name, value: c.code }))]} style={{ minWidth: 170 }} /><Select aria-label="Variable visible en el mapa" value={variable || 'all'} onChange={value => setVariable(value === 'all' ? undefined : value)} showSearch optionFilterProp="label" options={variableOptions(bootstrap.catalog)} className="map-variable" classNames={{ popup: { root: 'summary-variable-menu' } }} /></div><div className="map-legend"><span className="control-label">FIGURAS VISIBLES</span>{legends.map(([kind, label]) => <button key={kind} className={`legend-toggle ${visible.includes(kind) ? 'selected' : ''}`} aria-pressed={visible.includes(kind)} onClick={() => toggle(kind)}><Mark kind={kind} />{label}</button>)}<Select size="small" aria-label="Clasificación del resumen" value={classification} onChange={setClassification} options={[{ value: 'all', label: 'Todos los flags' }, { value: 'critical', label: 'Críticos' }, { value: 'normal', label: 'Normales' }, { value: 'positive', label: '+ Positivos' }]} /><button className={`legend-toggle dual-toggle ${agreement === 'both' ? 'selected' : ''}`} aria-pressed={agreement === 'both'} onClick={() => setAgreement(agreement === 'both' ? 'all' : 'both')}><DualBadge compact />Detectado por ambos</button><Tooltip title="? Sin evaluar · Reloj: falta una revisión · ! Evaluada con incidencias. Las variables sin datos se explican en el detalle y no vuelven pendiente una evaluación terminada."><span className="not-evaluated-legend"><i>?</i>Sin evaluar <ClockCircleOutlined />Falta modelo <ExclamationCircleOutlined />Incidencias</span></Tooltip></div>
      {!metrics.total ? <EmptyState /> : <div className="conversation-map" style={{ '--days': days.length }}><div className="map-scroll"><div className="map-head"><div className="map-name-head">PAÍS / ASISTENTE DE VENTA</div><div className="map-day-heads">{days.map((day, i) => <div key={day} className={i === 0 ? 'latest-day' : ''}>{i === 0 ? <><span className="status-dot" />Último día · </> : null}{dateText(day, { year: undefined, weekday: 'short' })}</div>)}</div></div>{groups.map(group => {
        const convs = data.conversations.filter(c => c.country === group.code);
        if (!convs.length) return null;
        const agents = [...new Map(convs.map(c => [c.agent.id, c.agent])).values()];
        return <section className="country-lanes" key={group.code}><div className="country-title"><button onClick={() => openHistory(group.code)}>{group.name}<span className="country-code">{group.code}</span><RightOutlined /></button><div>{['critical', 'normal', 'positive'].map(kind => { const count = convs.reduce((n, c) => n + flagCount(c, kind), 0); return count > 0 ? <PriorityTag key={kind} priority={kind} count={count} /> : null; })}</div></div>{agents.map(agent => <div className="agent-lane" key={agent.id}><div className="lane-name"><span className="agent-dot" />{agent.name}<span className="lane-volume">{convs.filter(c => c.agent.id === agent.id).length}</span></div><div className="lane-days">{days.map(day => <div className="day-cells" key={day}>{convs.filter(c => c.agent.id === agent.id && c.date === day).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(c => {
          const marks = c.marks.filter(m => (visible.includes(markKind(m)) || visible.includes(classificationOf(m)) && m.effective) && (!variable || m.id === variable) && (classification === 'all' || classificationOf(m) === classification));
          const kinds = [...new Set(marks.flatMap(m => m.kind === 'refuted' ? ['refuted'] : [classificationOf(m), ...(m.origin === 'human' || m.kind === 'human' ? ['human'] : [])]).filter(kind => visible.includes(kind)))];
          const agreed = dualMarks(c, variable).filter(m => classification === 'all' || classificationOf(m) === classification);
          const status = evaluationStatus(c), pending = status !== 'evaluated';
          return <Tooltip key={c.id} title={<div className="conversation-tooltip"><b>{c.client.name}{c.client.phoneLast4 ? ` · …${c.client.phoneLast4}` : ''}</b><span>{timeText(c.startedAt)} · {c.channel}</span><strong>{evaluationStatusLabel(c)}</strong><span>{marks.length ? marks.map(m => `${m.name}${m.kind === 'refuted' ? ' (refutado)' : ''}`).join(' · ') : c.evaluated ? noVisibleFlagsLabel(c) : 'Todavía no tiene resultados guardados'}</span>{c.unavailableFlags > 0 && <span>{c.unavailableFlags} variables sin datos o contexto suficientes</span>}{agreed.length > 0 && <strong>Detectado por ambos modelos: {agreed.map(m => m.name).join(' · ')}</strong>}</div>}><button className={`conversation-cell ${pending ? 'pending-cell' : ''} status-${status} ${agreed.length ? 'has-dual-detection' : ''}`} style={{ width: `${Math.max(31, kinds.length * 11 + (agreed.length ? 17 : 0) + (pending ? 12 : 0) + 8)}px` }} aria-label={`Abrir conversación de ${c.client.name}, ${agent.name}, ${day}, ${evaluationStatusLabel(c)}${c.evaluated ? `, ${flagCount(c, 'critical')} críticos, ${flagCount(c, 'normal')} normales y ${flagCount(c, 'positive')} positivos${agreed.length ? ', detectado por ambos modelos' : ''}` : ''}`} onClick={() => open(c)}>{kinds.map(kind => <Mark key={kind} kind={kind} small />)}{status === 'not_evaluated' && <span aria-label="Sin evaluar">?</span>}{status === 'review_pending' && <ClockCircleOutlined aria-label="Revisión pendiente" />}{status === 'partial' && <ExclamationCircleOutlined aria-label="Evaluada con incidencias" />}{agreed.length > 0 && <DualBadge compact />}</button></Tooltip>;
        })}</div>)}</div></div>)}</section>;
      })}</div></div>}<div className="map-footer"><span><span className="mini-rectangle" />Sin flags visibles · el detalle conserva todos los resultados</span><span>Más reciente a la izquierda <ArrowRightOutlined /> más antiguo</span></div></section>
  </>}</div>;
}
function Metric({ value, label, detail, accent, positive, title }) { return <Tooltip title={title}><div className={`metric-card ${accent ? 'metric-attention' : ''} ${positive ? 'metric-positive' : ''}`}><div className="metric-label">{label}{accent && <span className="attention-dot" />}</div><strong>{value}</strong><div className="metric-detail">{detail}</div></div></Tooltip>; }
