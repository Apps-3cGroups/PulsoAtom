import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Select, Tooltip } from 'antd';
import { ArrowRightOutlined, AppstoreOutlined, CalendarOutlined, RightOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { PageHeading, LoadingState, ErrorState, EmptyState, Mark, PriorityTag, dateText, timeText, previousDate } from '../components/common';
import QuickView from '../components/QuickView';

const legends = [['p1', 'P1'], ['p2', 'P2'], ['refuted', 'Refutado'], ['human', 'Por humano'], ['media', 'Multimedia'], ['coaching', 'Coaching']];
const variableOptions = catalog => [
  { label: 'Todas las variables', value: 'all' },
  ...[
    ['P1', variable => variable.mark === 'P1'],
    ['P2', variable => variable.mark === 'P2'],
    ['Coaching', variable => !['P1', 'P2', '+'].includes(variable.mark) && ['Flag', 'Calculado'].includes(variable.type)],
    ['Positivas', variable => variable.mark === '+'],
  ].map(([label, predicate]) => ({
    label: <span className={`variable-group-heading group-${label.toLowerCase()}`}><span className="variable-group-dot" aria-hidden="true" />{label}</span>,
    options: catalog.filter(predicate).map(variable => ({ label: variable.name, value: variable.id })),
  })).filter(group => group.options.length),
];
export default function Summary() {
  const { bootstrap } = usePortal();
  const navigate = useNavigate();
  const [range, setRange] = useState(4);
  const [country, setCountry] = useState();
  const [variable, setVariable] = useState();
  const [visible, setVisible] = useState(legends.map(([kind]) => kind));
  const [selected, setSelected] = useState(null);
  const selectedCell = useRef(null);
  const latest = bootstrap.dateRange.max;
  const to = latest || new Date().toISOString().slice(0, 10);
  const from = previousDate(to, range - 1);
  const { data, loading, error, reload } = useApi(`/summary?${queryString({ from, to, country })}`);
  const days = useMemo(() => Array.from({ length: range }, (_, i) => previousDate(to, i)), [to, range]);
  const open = c => navigate(`/conversacion/${encodeURIComponent(c.id)}`);
  const closeQuickView = () => {
    setSelected(null);
    requestAnimationFrame(() => selectedCell.current?.focus());
  };
  const openHistory = code => navigate(`/historico?${queryString({ from, to, country: code })}`);
  const toggle = kind => setVisible(current => current.includes(kind) ? current.filter(v => v !== kind) : [...current, kind]);
  const metrics = data?.metrics;
  const selectedView = data?.conversations?.find(c => c.id === selected?.id) || selected;
  const groups = bootstrap.countries.filter(c => !country || country === c.code);
  return <div className="summary-page"><PageHeading eyebrow="VISIÓN REGIONAL" title="Resumen de conversaciones" description="Identifica lo que requiere atención y explora la evidencia." actions={<div className="period-note"><CalendarOutlined /><span>{latest ? `${dateText(from)} — ${dateText(to)}` : 'Sin datos cargados'}</span></div>} />{error ? <ErrorState error={error} retry={reload} /> : loading ? <LoadingState /> : <>
    <div className="metrics-grid">
      <Metric value={metrics.total.toLocaleString('es-HN')} label="Conversaciones" detail={`${metrics.evaluated} evaluadas · ${metrics.pending} pendientes`} />
      <Metric value={metrics.alertPercent === null ? '—' : `${metrics.alertPercent}%`} label="Con P1 o P2" detail={`${metrics.withAlerts} conversaciones con flags vigentes`} accent title="Conversaciones evaluadas con al menos un P1/P2 vigente, del sistema o humano, divididas entre conversaciones evaluadas del período." />
      <Metric value={metrics.refutedPercent === null ? '—' : `${metrics.refutedPercent}%`} label="Alertas refutadas" detail={`${metrics.refuted} de ${metrics.originalAlerts} alertas del sistema`} title="Flags P1/P2 del sistema refutados por un supervisor, divididos entre todos los flags P1/P2 originales del sistema en el período." />
      <Metric value={metrics.human} label="Levantadas por humanos" detail="Eventos detectados en la revisión" />
      <Metric value={metrics.total ? `${Math.round(metrics.multimedia / metrics.total * 100)}%` : '—'} label="Con multimedia" detail={`${metrics.multimedia} con imagen, audio o llamada`} />
    </div>
    <section className="overview-panel"><div className="overview-header"><div><div className="eyebrow">MAPA DE CONVERSACIONES</div><h2>La atención, en perspectiva</h2></div><span className="muted small"><AppstoreOutlined /> Cada rectángulo es una conversación</span></div><div className="overview-controls"><div className="control-group"><span className="control-label">PERÍODO</span><div className="segmented-range">{[1, 4, 7, 14, 30].map(value => <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{value === 1 ? 'Último día' : `${value} días`}</button>)}</div></div><Select aria-label="País del resumen" value={country || 'all'} onChange={value => setCountry(value === 'all' ? undefined : value)} options={[{ label: 'Todos los países', value: 'all' }, ...bootstrap.countries.map(c => ({ label: c.name, value: c.code }))]} style={{ minWidth: 170 }} /><Select aria-label="Variable visible en el mapa" value={variable || 'all'} onChange={value => setVariable(value === 'all' ? undefined : value)} showSearch optionFilterProp="label" options={variableOptions(bootstrap.catalog)} className="map-variable" classNames={{ popup: { root: 'summary-variable-menu' } }} /></div><div className="map-legend"><span className="control-label">FIGURAS VISIBLES</span>{legends.map(([kind, label]) => <button key={kind} className={`legend-toggle ${visible.includes(kind) ? 'selected' : ''}`} aria-pressed={visible.includes(kind)} onClick={() => toggle(kind)}><Mark kind={kind} />{label}</button>)}<Tooltip title="Las conversaciones no evaluadas tienen un borde discontinuo y un signo de interrogación."><span className="not-evaluated-legend"><i>?</i>No evaluada</span></Tooltip></div>
      {!metrics.total ? <EmptyState /> : <div className={`conversation-map ${selected ? 'has-selection' : ''}`} style={{ '--days': days.length }}><div className="map-scroll"><div className="map-head"><div className="map-name-head">PAÍS / ASISTENTE DE VENTA</div><div className="map-day-heads">{days.map((day, i) => <div key={day} className={i === 0 ? 'latest-day' : ''}>{i === 0 ? <><span className="status-dot" />Último día · </> : null}{dateText(day, { year: undefined, weekday: 'short' })}</div>)}</div></div>{groups.map(group => {
        const convs = data.conversations.filter(c => c.country === group.code);
        if (!convs.length) return null;
        const agents = [...new Map(convs.map(c => [c.agent.id, c.agent])).values()];
        return <section className="country-lanes" key={group.code}><div className="country-title"><button onClick={() => openHistory(group.code)}>{group.name}<span className="country-code">{group.code}</span><RightOutlined /></button><div>{convs.some(c => c.p1) && <PriorityTag priority="P1" count={convs.reduce((n, c) => n + c.p1, 0)} />}{convs.some(c => c.p2) && <PriorityTag priority="P2" count={convs.reduce((n, c) => n + c.p2, 0)} />}</div></div>{agents.map(agent => <div className="agent-lane" key={agent.id}><div className="lane-name"><span className="agent-dot" />{agent.name}<span className="lane-volume">{convs.filter(c => c.agent.id === agent.id).length}</span></div><div className="lane-days">{days.map(day => <div className="day-cells" key={day}>{convs.filter(c => c.agent.id === agent.id && c.date === day).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(c => {
          const marks = c.marks.filter(m => visible.includes(m.kind) && (!variable || m.id === variable));
          const kinds = [...new Set(marks.map(m => m.kind))];
          if (visible.includes('media') && c.media.length > 0 && !variable && !kinds.includes('media')) kinds.push('media');
          return <Tooltip key={c.id} title={selected ? null : <div className="conversation-tooltip"><b>{c.client.name}{c.client.phoneLast4 ? ` · …${c.client.phoneLast4}` : ''}</b><span>{timeText(c.startedAt)} · {c.channel}</span><span>{!c.evaluated ? 'No evaluada' : c.marks.length ? c.marks.map(m => `${m.name}${m.kind === 'refuted' ? ' (refutado)' : ''}`).join(' · ') : 'Sin flags en el checklist evaluado'}</span></div>}><button className={`conversation-cell ${!c.evaluated ? 'pending-cell' : ''} ${selected?.id === c.id ? 'selected-cell' : ''}`} aria-label={`Vista rápida de ${c.client.name}, ${agent.name}, ${day}, ${c.evaluated ? `${c.p1} P1 y ${c.p2} P2` : 'no evaluada'}`} aria-pressed={selected?.id === c.id} onClick={event => { selectedCell.current = event.currentTarget; setSelected(c); }}>{!c.evaluated ? <span>?</span> : kinds.map(kind => <Mark key={kind} kind={kind} small />)}</button></Tooltip>;
        })}</div>)}</div></div>)}</section>;
      })}</div></div>}<div className="map-footer"><span><span className="mini-rectangle" />Sin flags en las variables evaluadas</span><span>Más reciente a la izquierda <ArrowRightOutlined /> más antiguo</span></div></section>
    <QuickView selected={selectedView} onClose={closeQuickView} onOpen={() => open(selectedView)} onSaved={reload} />
  </>}</div>;
}
function Metric({ value, label, detail, accent, title }) { return <Tooltip title={title}><div className={`metric-card ${accent ? 'metric-attention' : ''}`}><div className="metric-label">{label}{accent && <span className="attention-dot" />}</div><strong>{value}</strong><div className="metric-detail">{detail}</div></div></Tooltip>; }
