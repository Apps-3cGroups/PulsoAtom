import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@ant-design/v5-patch-for-react-19';
import { Alert, Button, ConfigProvider, Progress, Tag } from 'antd';
import { ArrowLeftOutlined, CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import 'antd/dist/reset.css';
import './style.css';
import { createApi, createCollector, createPoller, portalBase } from './progress.js';

const time = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('es-HN', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(value)) : '—';
const number = value => Number.isFinite(value) ? new Intl.NumberFormat('es-HN').format(value) : '—';
const pct = value => Number.isFinite(value) ? value.toLocaleString('es-HN', { maximumFractionDigits: 1 }) : '—';
const progress = (completed, total) => total > 0 ? Math.max(0, Math.min(100, completed / total * 100)) : 0;
const thursdayIncidents = thursday => thursday?.counts?.partial > 0 || thursday?.counts?.failed > 0;
function Brand() { return <span className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>Pulso<span className="brand-period">.</span></span></span>; }

function Monitor({ base }) {
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false), [clock, setClock] = useState(Date.now());
  const poller = useRef(null);
  useEffect(() => {
    const instance = createPoller({ collect: createCollector(createApi(base)), onStart: () => setBusy(true),
      onData: data => { setSnapshot(data); setError(null); setClock(Date.now()); }, onError: setError, onEnd: () => setBusy(false) });
    poller.current = instance; instance.refresh();
    const timer = setInterval(() => setClock(Date.now()), 15_000);
    return () => { clearInterval(timer); instance.stop(); };
  }, [base]);
  const auth = [401, 403].includes(error?.status);
  const stale = !!snapshot && (!!error || clock - Date.parse(snapshot.observedAt) > 90_000);
  const thursday = snapshot?.thursday, thursdayActive = !!thursday?.active;
  const waitingThursday = !!snapshot?.waitingThursday || snapshot?.runStatus === 'waiting_thursday';
  const recoveryActive = snapshot?.models.some(model => model.active);
  const quiet = !!snapshot && !snapshot.finished && !waitingThursday && !thursdayActive
    && (snapshot.stalled || !snapshot.preparing && snapshot.activity && clock - Date.parse(snapshot.activity) > 10 * 60_000);
  const recoveryWarning = !!snapshot && !waitingThursday && (snapshot.blocked || snapshot.interrupted || quiet || snapshot.paused);
  const thursdayWarning = !!thursday?.enabled && !thursdayActive && (thursday.stalled || thursdayIncidents(thursday) || ['blocked', 'failed'].includes(thursday.status));
  const status = auth ? 'Inicia sesión en Pulso' : stale ? 'Última lectura guardada'
    : thursdayActive ? 'Jueves en evaluación' : recoveryActive ? 'Recuperación de martes y miércoles en curso'
      : thursdayWarning ? 'La revisión del jueves requiere atención'
        : thursday?.enabled && (thursday.registered > 0 || waitingThursday) ? thursdayState(thursday)
          : snapshot?.finished ? 'Recuperación de martes y miércoles completada'
            : snapshot?.blocked ? 'La recuperación requiere atención' : quiet ? 'Sin actividad reciente en la recuperación'
              : snapshot?.paused ? 'Recuperación en pausa' : snapshot?.interrupted ? 'Recuperación interrumpida'
                : snapshot?.preparing ? 'Preparando siguientes revisiones' : 'Actualización automática';
  const warning = stale || thursdayWarning || !thursdayActive && recoveryWarning;
  return <div className="monitor-shell">
    <header className="monitor-topbar"><a href={`${base}/`} aria-label="Volver a Pulso"><Brand /></a><span className="topbar-divider" /><span className="monitor-name">Avance en vivo</span><a className="back-link" href={`${base}/evaluaciones`}><ArrowLeftOutlined /> Volver al portal</a></header>
    <main className="monitor-main">
      <div className="page-intro"><div><span className="eyebrow">HONDURAS Y PANAMÁ · 10, 11 Y 12 DE NOVIEMBRE</span><h1>Así avanza la revisión<span>.</span></h1><p>La carga del jueves y la recuperación de martes y miércoles, con sus avances por separado.</p></div><Button icon={<ReloadOutlined />} loading={busy && !!snapshot} disabled={busy} onClick={() => poller.current?.refresh()}>Actualizar ahora</Button></div>
      <div className={`connection-strip${warning ? ' connection-warning' : ''}`} role="status"><span><i className={!error && !warning ? 'pulse-dot' : ''} />{status}{!error && <small> · cada 30 segundos</small>}</span><span>{snapshot ? `Última consulta: ${time(snapshot.observedAt)}` : 'Conectando con Pulso…'} <small>· hora de Honduras</small></span></div>
      {error && <Alert type={auth ? 'warning' : 'error'} showIcon message={error.message} action={auth ? <Button href={`${base}/`} target="_blank" rel="noopener noreferrer">Iniciar sesión</Button> : undefined} />}
      {!snapshot ? <section className="waiting-panel" aria-busy={busy}><Brand /><h2>{error ? 'El avance aparecerá al recuperar la conexión' : 'Consultando la corrida actual'}</h2><p>{error ? 'Inicia sesión en Pulso y vuelve aquí para actualizar.' : 'Leyendo los resultados guardados de Honduras y Panamá.'}</p></section> : <>
        <ThursdaySection thursday={thursday} stale={stale} base={base} />
        <section className="recovery-section" aria-labelledby="recovery-heading">
          <div className="section-heading"><div><span className="eyebrow">ALCANCE FIJO · 212 CONVERSACIONES</span><h2 id="recovery-heading">Recuperación de martes y miércoles</h2><p>Martes 10 y miércoles 11 de noviembre · {number(snapshot.total)} revisiones pendientes al iniciar esta recuperación.</p></div><Tag color={snapshot.finished ? 'success' : waitingThursday || thursdayActive ? 'default' : recoveryActive ? 'processing' : 'default'}>{snapshot.finished ? 'Completada' : waitingThursday || thursdayActive ? 'Jueves tiene prioridad' : recoveryActive ? 'En curso' : 'Recuperación pendiente'}</Tag></div>
          <Alert type="info" showIcon message={`${number(snapshot.preserved)} revisiones anteriores conservadas · ${snapshot.excluded} conversación excluida por autorización, sin borrar sus resultados.`} />
          <section className="progress-overview" aria-label="Avance de la recuperación de martes y miércoles">
            <div className="progress-main"><div className="progress-heading"><span className="eyebrow">RECUPERACIÓN · REVISIONES DE MODELOS</span><Tag bordered={false}>{number(snapshot.target)} conversaciones · {number(snapshot.total)} revisiones</Tag></div><div className="progress-content"><Donut completed={snapshot.completed} total={snapshot.total} percent={snapshot.percent} stale={stale} unit="revisiones" /><div className="progress-copy"><div className="progress-percent">{pct(snapshot.percent)}<span>%</span></div><h3>{snapshot.finished ? 'Recuperación completada.' : snapshot.tuesdayBlocked ? 'El remanente del martes requiere revisión.' : waitingThursday || thursdayActive ? 'El remanente del martes da prioridad al jueves.' : recoveryActive ? 'La recuperación está evaluando.' : snapshot.preparing ? 'Preparando siguientes revisiones.' : 'Recuperación pendiente de continuar.'}</h3><p>Solo las revisiones completas cuentan en este avance. Las parciales y fallidas conservan sus resultados. Este total se muestra por separado del jueves.</p></div></div><div className="progress-bottom"><span>{number(snapshot.running)} {snapshot.running === 1 ? 'revisión' : 'revisiones'} en proceso</span><span>Procesamiento: <b>{number(snapshot.concurrency)} a la vez</b></span></div></div>
            <div className="count-grid"><Count title="Completas" value={snapshot.completed} text="Revisiones con checklist completo" tone="blue" icon={<CheckCircleOutlined />} /><Count title="Pendientes" value={snapshot.pending} text="Revisiones que esperan su turno" tone="muted" icon={<ClockCircleOutlined />} /><Count title="Parciales" value={snapshot.partial} text="Falta parte del checklist" tone="amber" icon={<ExclamationCircleOutlined />} /><Count title="En proceso" value={snapshot.running} text="Revisiones de modelos en curso" tone="blue" icon={<ReloadOutlined />} /><div className="error-count"><span>Fallidas</span><strong>{number(snapshot.failed)}</strong><span>Separadas de las parciales</span></div></div>
          </section>
          <section className="country-grid" aria-label="Revisiones completas por día del lote de recuperación">{snapshot.phases.map(phase => <article className="country-card" key={phase.key}><div><span className="country-code">{phase.code}</span><h3>{phase.name}</h3><b>{number(phase.target)} conversaciones</b></div><Progress percent={progress(phase.counts.completed, phase.totalReviews)} showInfo={false} strokeColor="#6174a8" /><p><strong>{number(phase.counts.completed)} / {number(phase.totalReviews)}</strong> revisiones completas · {phase.unassigned ? `${number(phase.unassigned)} conversaciones esperan la creación de su lote` : 'Lote asignado'}</p><small>{phase.key === 'tuesday' ? '167 nuevas con ambos modelos + 2 revisiones pendientes de Gemma. Una conversación excluida.' : '43 conversaciones iniciadas el miércoles; 41 tienen su última actividad el jueves y aparecen ese día en Resumen.'}</small></article>)}</section>
          <p className="scope-note">Los días de este lote corresponden a su selección para recuperación. El mapa de Resumen agrupa por última actividad, por lo que sus cantidades por día pueden ser distintas.</p>
          {snapshot.tuesdayBlocked && !stale && <Alert type="warning" showIcon message="El remanente del martes requiere revisión antes de retomarse. El jueves conserva su prioridad." />}
          {recoveryWarning && !thursdayActive && !stale && <Alert type="warning" showIcon message={snapshot.blocked ? 'La recuperación se detuvo y conserva los resultados guardados.' : snapshot.paused ? 'La recuperación está en pausa por otro mantenimiento.' : snapshot.interrupted ? 'Hay un lote de recuperación interrumpido por retomar.' : 'No hay actividad guardada en la recuperación en los últimos 10 minutos.'} />}
          <details className="recovery-details"><summary>Ver Clef, Gemma y los lotes de la recuperación <span>{number(snapshot.completed)} de {number(snapshot.total)} revisiones completas</span></summary><div className="recovery-details-content"><ModelGrid models={snapshot.models} stale={stale} label="Modelos de la recuperación de martes y miércoles" pausedReason={waitingThursday || thursdayActive ? 'Las pendientes del martes se retoman después de dar prioridad al jueves.' : null} /><BatchDetails batches={snapshot.batches} base={base} label="recuperación" /></div></details>
        </section>
        <footer className="monitor-footer"><span>Última actividad: jueves <b>{time(thursday?.activity)}</b> · recuperación <b>{time(snapshot.activity)}</b></span><span>Solo lectura · Actualización automática cada 30 segundos.</span></footer>
      </>}
    </main>
  </div>;
}

function thursdayState(thursday) {
  if (!thursday?.enabled) return 'Jueves pendiente de programación';
  if (thursday.active) return 'Jueves en evaluación';
  if (thursdayIncidents(thursday)) return 'Jueves requiere revisión';
  if (thursday.stalled || ['blocked', 'failed'].includes(thursday.status)) return 'Jueves requiere atención';
  if (thursday.status === 'completed') return 'Revisión del jueves completada';
  if (thursday.registered > 0 && thursday.remaining === 0) return 'Al día con lo registrado';
  if (thursday.registered > 0) return 'Jueves pendiente de continuar';
  return 'Aún no hay conversaciones registradas';
}

function ThursdaySection({ thursday, stale, base }) {
  const active = !!thursday?.active, label = thursdayState(thursday);
  const registered = thursday?.registered, completed = thursday?.completed, percent = progress(completed, registered);
  const countries = ['HN', 'PA'].map(country => thursday?.countries?.find(row => row.country === country)
    || { country, label: country === 'HN' ? 'Honduras' : 'Panamá' });
  const warnings = (thursday?.warnings || []).filter(value => typeof value === 'string');
  return <section className="thursday-section" aria-labelledby="thursday-heading">
    <div className="section-heading"><div><span className="eyebrow">CARGA DEL JUEVES · CONVERSACIONES</span><h2 id="thursday-heading">Jueves 12 de noviembre</h2><p>Honduras y Panamá · Clef y Gemma sobre las conversaciones registradas.</p></div><Tag color={stale ? 'default' : active ? 'processing' : thursday?.stalled || thursdayIncidents(thursday) || ['blocked', 'failed'].includes(thursday?.status) ? 'warning' : registered > 0 && thursday?.remaining === 0 ? 'success' : 'default'}>{stale ? 'Último estado conocido' : label}</Tag></div>
    <section className="progress-overview thursday-overview" aria-label="Avance de conversaciones del jueves">
      <div className="progress-main"><div className="progress-heading"><span className="eyebrow">JUEVES · CONVERSACIONES ÚNICAS</span><Tag bordered={false}>{active ? 'Corrida actual' : 'Carga del jueves'}</Tag></div><div className="progress-content"><Donut completed={completed} total={registered} percent={percent} stale={stale} unit="conversaciones" /><div className="progress-copy"><div className="progress-percent">{registered > 0 ? pct(percent) : '—'}{registered > 0 && <span>%</span>}</div><h3>{label}.</h3><p>{active ? 'Clef y Gemma están revisando el jueves. Aquí se cuenta cada conversación una sola vez.' : registered > 0 && thursday?.remaining === 0 ? 'Las conversaciones registradas ya tienen sus revisiones completas. Se pueden incorporar nuevos lotes.' : 'El avance se actualiza conforme se registran y se revisan las conversaciones del jueves.'}</p></div></div><div className="progress-bottom"><span>{number(thursday?.runningConversations)} {thursday?.runningConversations === 1 ? 'conversación' : 'conversaciones'} en proceso</span><span>Máximo: <b>{number(thursday?.limitPerCountry)} por país</b> · <b>{number(thursday?.concurrency)} a la vez</b></span></div></div>
      <div className="count-grid"><Count title="Registradas" value={registered} text="Conversaciones únicas en los lotes" tone="blue" icon={<ClockCircleOutlined />} /><Count title="Completas" value={completed} text="Con revisión completa de ambos modelos" tone="green" icon={<CheckCircleOutlined />} /><Count title="Pendientes" value={thursday?.remaining} text="Registradas que aún no están completas" tone="amber" icon={<ClockCircleOutlined />} /><Count title="En proceso" value={thursday?.runningConversations} text="Conversaciones que se están evaluando" tone="blue" icon={<ReloadOutlined />} /></div>
    </section>
    <div className="country-table-panel"><div className="country-table-heading"><h3>Jueves por país</h3><span>{number(thursday?.reused)} conversaciones con resultados previos reutilizados</span></div><div className="country-table-scroll" tabIndex={0} aria-label="Tabla del jueves por país"><table className="country-table"><caption className="visually-hidden">Conversaciones registradas, reutilizadas, completas y pendientes del jueves 12 de noviembre</caption><thead><tr><th scope="col">País</th><th scope="col">Registradas</th><th scope="col">Reutilizadas</th><th scope="col">Completas</th><th scope="col">Pendientes</th></tr></thead><tbody>{countries.map(country => <tr key={country.country}><th scope="row"><span className="country-code">{country.country}</span>{country.country === 'PA' ? 'Panamá' : 'Honduras'}</th><td>{number(country.registered)}</td><td>{number(country.reused)}</td><td className="complete-cell">{number(country.completed)}</td><td>{number(country.remaining)}</td></tr>)}</tbody></table></div><p className="table-note">Las reutilizadas ya están incluidas en las completas; no se suman de nuevo.</p></div>
    <p className="scope-note">Se cuentan conversaciones únicas registradas en los lotes y se incorporan resultados previos. Estas cifras no representan toda la cola de Automations ni confirman que haya terminado de enviar la carga. Los totales del jueves y de la recuperación se muestran por separado para evitar contar una conversación dos veces.</p>
    {(thursdayIncidents(thursday) || !active && (thursday?.stalled || ['blocked', 'failed'].includes(thursday?.status))) && !stale && <Alert type="warning" showIcon message={active ? 'Hay revisiones del jueves con incidencias. La evaluación continúa y conserva los resultados guardados.' : 'La revisión del jueves requiere atención. Conservamos los resultados guardados.'} />}
    {warnings.length > 0 && !stale && <Alert type="info" showIcon message="Sobre la carga del jueves" description={<ul className="monitor-warnings">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>} />}
    {!!thursday?.models?.length && <div className="model-section-heading"><h3>Revisiones nuevas por modelo</h3><p>Aquí se muestran las nuevas revisiones asignadas. Las conversaciones con resultados reutilizados ya están incluidas arriba en Completas.</p></div>}
    <ModelGrid models={thursday?.models || []} stale={stale} label="Revisiones nuevas de los modelos del jueves" newReviews />
    <BatchDetails batches={thursday?.batches || []} base={base} label="jueves" />
  </section>;
}

function Donut({ completed, total, percent, stale, unit }) {
  return <div className="donut"><Progress type="circle" percent={percent} size={196} strokeWidth={7} strokeColor={stale ? '#8792a6' : '#4f5fd5'} trailColor="#edf0f7" format={() => <div className="donut-label"><strong>{number(completed)}</strong><span>de {number(total)} {unit}</span></div>} /></div>;
}
function ModelGrid({ models, stale, label, pausedReason, newReviews = false }) {
  if (!models.length) return null;
  return <section className="model-grid" aria-label={label}>{models.map((model, index) => {
    const active = model.active;
    const complete = model.total > 0 && model.completed === model.total;
    const issue = model.partial > 0 || model.failed > 0;
    const status = stale ? 'Último estado conocido' : active ? 'En curso' : complete ? 'Completado' : issue ? 'Con incidencias' : model.total ? pausedReason ? 'Pendiente por prioridad' : 'Pendiente' : newReviews ? 'Sin revisiones nuevas' : 'Sin revisiones registradas';
    return <article className={`model-card model-${index}`} key={model.id}><div className="model-card-head"><div><span className="eyebrow">MODELO {index + 1}</span><h3>{model.label}</h3><span className="model-code">{model.model}</span></div><Tag color={stale ? 'default' : active ? 'processing' : complete ? 'success' : issue ? 'warning' : 'default'}>{status}</Tag></div><div className="model-amount"><strong>{number(model.completed)}<span> / {number(model.total)}</span></strong><b>{pct(model.percent ?? progress(model.completed, model.total))}%</b></div><Progress percent={model.percent ?? progress(model.completed, model.total)} showInfo={false} strokeColor={index ? '#8b65c9' : '#4f5fd5'} trailColor="#edf0f7" /><div className="model-counts"><Metric label="Completas" value={model.completed} /><Metric label="Parciales" value={model.partial} /><Metric label="Fallidas" value={model.failed} /><Metric label="En proceso" value={model.running} /><Metric label="Pendientes" value={model.pending} /></div><p>{active ? 'Está procesando las revisiones asignadas.' : issue ? 'Hay revisiones con incidencias; se conservan los resultados guardados.' : model.pending ? pausedReason || 'Las pendientes se procesan en el orden del lote.' : model.total ? 'Las revisiones registradas de este modelo están completas.' : newReviews ? 'Todavía no hay revisiones nuevas asignadas a este modelo.' : 'Todavía no hay revisiones registradas de este modelo.'}</p></article>;
  })}</section>;
}
function BatchDetails({ batches, base, label }) {
  if (!Array.isArray(batches) || !batches.length) return null;
  return <details className="run-details"><summary>Ver {batches.length === 1 ? 'el lote' : `los ${number(batches.length)} lotes`} de {label === 'recuperación' ? 'la recuperación' : 'jueves'}</summary><div className="run-list">{batches.map((batch, index) => <div key={batch.id || index}><b>{batch.label || `Lote ${index + 1}`} · {number(batch.cases)} conversaciones</b>{batch.id && <span className="run-id">{String(batch.id).slice(0, 8)}</span>}{(batch.models || []).map(model => <span key={model.id}>{model.label}: <strong>{number(model.completed)}/{number(model.total)}</strong></span>)}<a href={`${base}/evaluaciones`}>Ver detalle →</a></div>)}</div></details>;
}
function Metric({ label, value }) { return <div><strong>{number(value)}</strong><span>{label}</span></div>; }
function Count({ title, value, text, tone, icon }) { return <article className={`count-card count-${tone}`}><div><span>{title}</span>{icon}</div><strong>{number(value)}</strong><p>{text}</p></article>; }
let base, routeError;
try { base = portalBase(window.location.pathname); } catch (error) { routeError = error; }
createRoot(document.getElementById('root')).render(<ConfigProvider theme={{ token: { colorPrimary: '#4f5fd5', colorInfo: '#4f5fd5', fontFamily: '"Instrument Sans", sans-serif', colorText: '#20283b', borderRadius: 10 }, components: { Button: { primaryShadow: 'none' } } }}>{routeError ? <Alert type="error" message={routeError.message} /> : <Monitor base={base} />}</ConfigProvider>);
