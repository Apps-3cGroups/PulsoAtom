import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Drawer, Input, Select, Tooltip } from 'antd';
import { BarChartOutlined, FilterOutlined, InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useApi, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { comparisonScale, duration, metricLeader, modelDashboardDefaultFilters, modelDashboardPeriodLabel, number, percentage, resetModelDashboardFilters } from '../services/modelDashboard';
import { EmptyState, ErrorState, LoadingState, dateText } from '../components/common';
import './model-dashboard.css';

function ComparisonBars({ models, values, format = number, ceiling, details = [] }) {
  const widths = comparisonScale(values, ceiling);
  return <div className="model-bars">{models.map((model, i) => <div className={`model-bar-row model-color-${i}`} key={model.id}>
    <div className="model-bar-label"><span><i />{model.label}</span><strong>{values[i] === null || values[i] === undefined ? 'Sin datos' : format(values[i])}</strong></div>
    <div className={`model-bar-track ${widths[i] === null ? 'model-bar-unavailable' : ''}`} aria-hidden="true"><div style={{ width: `${widths[i] || 0}%` }} /></div>
    <span className="model-bar-detail" aria-hidden={!details[i] || undefined}>{details[i] || '\u00a0'}</span>
  </div>)}</div>;
}

function KpiCard({ models, metric, title, direction, help, format, ceiling, details, note }) {
  const leader = direction ? metricLeader(models, metric, direction === 'lower') : null;
  return <article className="model-kpi">
    <header><h2>{title}</h2><Tooltip title={help}><button type="button" className="model-info" aria-label={`Cómo se calcula: ${title}`}><InfoCircleOutlined /></button></Tooltip></header>
    <div className="model-kpi-direction">{direction === 'lower' ? 'MENOR ES MEJOR' : direction === 'higher' ? 'MAYOR ES MEJOR' : 'VOLUMEN OBSERVADO'}</div>
    <ComparisonBars models={models} values={models.map(m => m[metric])} format={format} ceiling={ceiling} details={details} />
    <footer><span>{leader ? leader.tie ? 'Mismo resultado' : <><i className={`model-dot model-color-${leader.index}`} />{leader.label} lidera</> : note || 'Sin base comparable'}</span></footer>
  </article>;
}

function Insight({ title, leader, children }) {
  return <div className="model-insight"><span>{title}</span><strong>{leader ? leader.tie ? 'Empate' : leader.label : 'Sin datos'}</strong><small>{children}</small></div>;
}

export default function ModelDashboard() {
  const navigate = useNavigate();
  const { bootstrap } = usePortal();
  const [filters, setFilters] = useState(() => modelDashboardDefaultFilters(bootstrap));
  const [draft, setDraft] = useState(filters);
  const [showFilters, setShowFilters] = useState(false);
  const path = `/model-dashboard?${queryString(filters)}`;
  const request = useApi(path);
  const data = request.data;
  const cohort = data?.cohort;
  const models = (data?.metrics || []).map(model => ({ ...model, incomplete: cohort.conversations - model.completed }));
  const invalidDates = draft.from && draft.to && draft.from > draft.to;
  const switchModel = (side, value) => {
    const next = { ...filters, left: data.selected.left || '', right: data.selected.right || '', [side]: value };
    setFilters(next); setDraft(current => ({ ...current, ...next }));
  };
  const flagCount = cohort?.flagsMin === cohort?.flagsMax ? number(cohort?.flagsMin ?? 0) : `${number(cohort?.flagsMin ?? 0)}–${number(cohort?.flagsMax ?? 0)}`;
  const fastest = metricLeader(models, 'averageMs', true);
  const coverage = metricLeader(models, 'coverage');
  const periodLabel = modelDashboardPeriodLabel(filters, modelDashboardDefaultFilters(bootstrap));
  const labelFor = (profile, all) => `${profile.label} · ${profile.model || 'Sin configurar'}${all.filter(p => p.profileId === profile.profileId && p.model === profile.model).length > 1 ? ` · ${profile.id.split('@').at(-1).slice(0, 6)}` : ''}`;

  return <div className="model-dashboard">
    <div className="page-heading"><div><div className="eyebrow">INTELIGENCIA ARTIFICIAL / RENDIMIENTO</div><h1>Comparativo de modelos</h1><p>Rendimiento global de {models.length === 2 ? models.map(m => m.label.replace(/ · demo$/, '')).join(' y ') : 'Clef y Gemma'}, en una sola vista.</p></div><div className="heading-actions"><Button icon={<FilterOutlined />} onClick={() => setShowFilters(true)}>Filtros</Button><Button icon={<ReloadOutlined />} loading={request.loading} onClick={request.reload}>Actualizar</Button></div></div>
    <Drawer title="Filtrar comparativo" open={showFilters} onClose={() => setShowFilters(false)} width={420}><p className="model-drawer-intro">El período usa la fecha de la ejecución. Ambos modelos comparten los mismos filtros.</p><form className="model-dashboard-filters" onSubmit={e => { e.preventDefault(); if (!invalidDates) { setFilters({ ...draft }); setShowFilters(false); } }}>
      <label>Evaluaciones desde<Input type="date" aria-label="Evaluaciones desde" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} /></label>
      <label>Hasta<Input type="date" aria-label="Evaluaciones hasta" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} /></label>
      <label>País<Select aria-label="Filtrar país" value={draft.country} onChange={country => setDraft({ ...draft, country })} options={[{ value: '', label: 'Todos los países' }, ...(data?.countries || []).map(value => ({ value, label: value }))]} /></label>
      <Button type="primary" htmlType="submit" disabled={!!invalidDates} loading={request.loading}>Aplicar</Button><Button onClick={() => { const next = resetModelDashboardFilters({ ...filters, left: data?.selected?.left || filters.left, right: data?.selected?.right || filters.right }, bootstrap); setDraft(next); setFilters(next); setShowFilters(false); }}>Restablecer últimos 7 días</Button>
    </form>
    {invalidDates && <Alert type="error" showIcon message="La fecha inicial debe ser anterior o igual a la fecha final." />}</Drawer>
    {request.error ? <ErrorState error={request.error} retry={request.reload} /> : !data || request.loading || request.dataPath !== path ? <LoadingState /> : <>
      <div className="model-comparison-context"><div className="model-selectors">{['left', 'right'].map((side, i) => <div className={`model-selector model-color-${i}`} key={side}><i className="model-dot" /><Select aria-label={`Modelo ${i + 1}`} value={data.selected[side] || undefined} placeholder={`Selecciona el modelo ${i + 1}`} onChange={value => switchModel(side, value)} options={data.profiles.map(p => ({ value: p.id, label: labelFor(p, data.profiles), disabled: models.some((m, index) => index !== i && (m.id === p.id || (m.provider === p.provider && m.model === p.model))) }))} /></div>)}</div><button className="model-filter-summary" onClick={() => setShowFilters(true)}>{filters.country || 'Todos los países'} · {periodLabel} <FilterOutlined /></button></div>
      {data.demo && <Alert type="warning" showIcon message="Datos de demostración. Estos tiempos y resultados no miden el rendimiento real de los proveedores." />}
      {!cohort.conversations ? <section className="model-empty"><EmptyState title="Todavía no hay evaluaciones comparables" description="No hay resultados de ambos modelos para estos filtros. Selecciona otro período o país." /><Button type="primary" onClick={() => navigate('/evaluaciones')}>Ir a Evaluaciones</Button></section> : <>
        <section className="model-executive-summary" aria-label="Lectura ejecutiva">
          <div className="model-cohort"><span className="eyebrow">BASE COMPARABLE</span><strong>{number(cohort.conversations)} <small>conversaciones</small></strong><p>Mismas conversaciones para ambos modelos.</p></div>
          <Insight title="MENOR TIEMPO PROMEDIO" leader={fastest}>{fastest && !fastest.tie ? `${percentage(fastest.other ? 1 - fastest.value / fastest.other : null)} menos tiempo` : `${number(cohort.timed)} conversaciones con tiempos de ambos`}</Insight>
          <Insight title="MAYOR COBERTURA" leader={coverage}>{coverage ? coverage.tie ? 'Mismo porcentaje de flags con conclusión' : `${number((coverage.value - coverage.other) * 100)} puntos porcentuales más de cobertura` : 'Sin base comparable'}</Insight>
        </section>
        <div className="model-grid-caption"><span><BarChartOutlined /> Mismo gráfico, mismos colores en todos los indicadores.</span><span>Escala compartida dentro de cada KPI.</span></div>
        <section className="model-kpi-grid" aria-label="Indicadores comparativos">
          <KpiCard models={models} metric="averageMs" title="Tiempo promedio" direction="lower" format={duration} help="Tiempo medio por evaluación, incluidos los reintentos, sobre las mismas conversaciones." details={models.map(() => `${number(cohort.timed)} evaluaciones con tiempo registrado`)} />
          <KpiCard models={models} metric="minMs" title="Respuesta más rápida" direction="lower" format={duration} help="El menor tiempo registrado por cada modelo en las conversaciones comparadas." />
          <KpiCard models={models} metric="maxMs" title="Respuesta más lenta" direction="lower" format={duration} help="El mayor tiempo registrado por cada modelo en las conversaciones comparadas." />
          <KpiCard models={models} metric="coverage" title="Cobertura de evaluación" direction="higher" format={percentage} ceiling={1} help="Porcentaje de flags con una conclusión válida de presencia o ausencia. Mide cobertura, no exactitud ni certeza." details={models.map(m => `${number(m.answered / cohort.conversations)} de ${flagCount} flags con conclusión, en promedio`)} />
          <KpiCard models={models} metric="completionRate" title="Evaluaciones completas" direction="higher" format={percentage} ceiling={1} help="Porcentaje de evaluaciones que el modelo terminó de procesar." details={models.map(m => `${number(m.completed)} de ${number(cohort.conversations)} evaluaciones`)} />
          <KpiCard models={models} metric="incomplete" title="Evaluaciones incompletas" direction="lower" help="Evaluaciones con fallos, respuestas parciales o todavía pendientes de terminar." details={models.map(() => `De ${number(cohort.conversations)} evaluaciones comparadas`)} />
        </section>
        <div className="model-cohort-note"><InfoCircleOutlined /><p>{number(cohort.conversations)} conversaciones comparadas · {number(cohort.timed)} con tiempos de ambos modelos{cohort.excluded > 0 && ` · ${number(cohort.excluded)} sin comparación disponible`}. Actualizado {dateText(data.generatedAt, { hour: '2-digit', minute: '2-digit' })}</p></div>
      </>}

    </>}
  </div>;
}
