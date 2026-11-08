import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@ant-design/v5-patch-for-react-19';
import { Alert, Button, ConfigProvider, Progress, Table, Tag, Tooltip } from 'antd';
import { ArrowLeftOutlined, ArrowUpOutlined, CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, PauseCircleOutlined, ReloadOutlined, RightOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import 'antd/dist/reset.css';
import './style.css';
import { createApi, createCollector, createPoller, portalBase } from './progress.js';

const time = value => value ? new Intl.DateTimeFormat('es-HN', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(value)) : '—';
const number = value => new Intl.NumberFormat('es-HN').format(value);
function Brand({ loading = false }) { return <span className={`brand${loading ? ' brand-loading' : ''}`}><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>Pulso<span className="brand-period">.</span></span></span>; }

function Monitor({ base }) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const poller = useRef(null);
  useEffect(() => {
    const instance = createPoller({ collect: createCollector(createApi(base)), onStart: () => setBusy(true),
      onData: value => { setSnapshot(value); setError(null); setClock(Date.now()); },
      onError: setError, onEnd: () => setBusy(false) });
    poller.current = instance;
    instance.refresh();
    const timer = setInterval(() => setClock(Date.now()), 15_000);
    return () => { clearInterval(timer); instance.stop(); };
  }, [base]);
  const authError = [401, 403].includes(error?.status);
  const stale = !!snapshot && (!!error || clock - Date.parse(snapshot.observedAt) > 90_000);
  const quiet = snapshot && !snapshot.finished && snapshot.activity && clock - Date.parse(snapshot.activity) > 10 * 60_000;
  const status = authError ? 'Sesión requerida' : stale ? 'Lectura desactualizada' : snapshot?.finished ? 'Revisión finalizada' : snapshot?.interrupted ? 'Revisión interrumpida' : quiet ? 'Sin actividad reciente' : 'Actualización automática';
  const headline = stale || quiet ? 'Último avance conocido.' : snapshot?.finished ? 'La revisión llegó al final.' : snapshot?.interrupted ? 'Hay una revisión por retomar.' : snapshot?.running ? 'Una conversación en revisión.' : 'Resultados guardados hasta ahora.';
  return <div className="monitor-shell">
    <header className="monitor-topbar"><a href={`${base}/`} aria-label="Volver a Pulso"><Brand /></a><span className="topbar-divider" /><span className="monitor-name">Monitor de evaluación</span><a className="back-link" href={`${base}/evaluaciones`}><ArrowLeftOutlined /> Volver al portal</a></header>
    <main className="monitor-main">
      <div className="page-intro"><div><span className="eyebrow">SEGUIMIENTO DEL LOTE</span><h1>Clef, conversación a conversación<span>.</span></h1><p>Las mismas 500 conversaciones revisadas con Gemma. Aquí puedes seguir la revisión de Clef.</p></div><Button icon={<ReloadOutlined />} loading={busy && !!snapshot} disabled={busy} onClick={() => poller.current?.refresh()}>Actualizar ahora</Button></div>
      <div className={`connection-strip${stale || quiet || snapshot?.interrupted ? ' connection-warning' : ''}`}><span><i className={!error && !snapshot?.finished && !quiet ? 'pulse-dot' : ''} />{status}{!error && !snapshot?.finished && <small> · cada 30 segundos</small>}</span><span>{snapshot ? `Última consulta: ${time(snapshot.observedAt)}` : 'Conectando con Pulso…'} <small>· Tegucigalpa</small></span></div>
      {error && <Alert type={authError ? 'warning' : 'error'} showIcon message={error.message} action={authError ? <Button href={`${base}/`} target="_blank" rel="noopener noreferrer">Abrir Pulso <ArrowUpOutlined rotate={45} /></Button> : undefined} />}
      {!snapshot ? <section className="waiting-panel" aria-busy={busy}><Brand loading={busy} /><h2>{error ? 'El avance estará aquí cuando recuperemos la conexión' : 'Consultando el avance de Clef'}</h2><p>{error ? 'Después de iniciar sesión, vuelve a esta pestaña y pulsa Actualizar ahora.' : 'Leemos las revisiones guardadas. Esto no inicia nuevas evaluaciones.'}</p></section> : <>
        <section className="progress-overview" aria-label="Avance del lote de 500 conversaciones">
          <div className="progress-main"><div className="progress-heading"><span className="eyebrow">AVANCE DE CLEF</span><Tag bordered={false}>{snapshot.finished ? 'Lote terminado' : 'Lote de 500'}</Tag></div><div className="progress-content"><div className="donut"><Progress type="circle" percent={snapshot.percent} size={224} strokeWidth={7} strokeColor={stale ? '#82968d' : '#167963'} trailColor="#e9efe8" format={() => <div className="donut-label"><strong>{number(snapshot.processed)}</strong><span>de 500 procesadas</span></div>} /></div><div className="progress-copy"><div className="progress-percent">{snapshot.percent.toLocaleString('es-HN', { maximumFractionDigits: 1 })}<span>%</span></div><h2>{headline}</h2><p>{snapshot.finished ? 'Revisa los resultados y los casos que quedaron parciales.' : 'Las revisiones completas, parciales y fallidas forman el avance procesado. Los pendientes todavía no han terminado.'}</p></div></div><div className="progress-bottom"><span><SafetyCertificateOutlined /> Consulta de solo lectura</span><span>Modelo <b>Clef Flash</b></span></div></div>
          <div className="count-grid">
            <Count title="Completas" value={snapshot.completed} text="Evaluación completa guardada" tone="green" icon={<CheckCircleOutlined />} />
            <Count title="Parciales" value={snapshot.partial} text="Hay resultados; falta parte del checklist" tone="amber" icon={<ExclamationCircleOutlined />} />
            <Count title="En proceso" value={snapshot.running} text="Según el último estado guardado" tone="blue" icon={<ReloadOutlined />} />
            <Count title="Pendientes" value={snapshot.pending} text="Todavía no han terminado" tone="muted" icon={<ClockCircleOutlined />} />
            <div className="error-count"><span><PauseCircleOutlined /> Fallidas</span><strong>{snapshot.failed}</strong><span>No equivalen a “sin flags”</span></div>
          </div>
        </section>
        {(quiet || snapshot.interrupted) && !stale && <Alert type="warning" showIcon message={snapshot.interrupted ? 'Una revisión figura interrumpida. Este monitor no la reanuda automáticamente.' : 'No observamos actividad guardada en los últimos 10 minutos. Esto requiere revisión; no confirma por sí solo que el proceso se haya detenido.'} />}
        <section className="batch-panel"><div className="batch-heading"><div><span className="eyebrow">POR BLOQUES</span><h2>El recorrido de las 500 conversaciones</h2></div><span>{snapshot.batches.length} de 25 bloques creados</span></div><div className="batch-track" aria-label="Estado de los 25 bloques">{Array.from({ length: 25 }, (_, i) => {
          const batch = snapshot.batches.find(b => b.index === i + 1);
          const processed = batch ? batch.completed + batch.partial + batch.failed : 0;
          const label = batch ? `Bloque ${i + 1}: ${processed} de ${batch.total} procesadas` : `Bloque ${i + 1}: pendiente de crear`;
          return <Tooltip key={i} title={label}><span className={`batch-cell ${batch?.running ? 'batch-running' : processed === batch?.total ? (batch.partial || batch.failed ? 'batch-partial' : 'batch-complete') : ''}`} aria-label={label}><span>{i + 1}</span><i style={{ height: `${batch ? processed / batch.total * 100 : 0}%` }} /></span></Tooltip>;
        })}</div><p className="track-caption">Cada bloque agrupa hasta 20 conversaciones. Los bloques todavía no creados ya cuentan entre las pendientes.</p>
          <Table size="small" rowKey="id" dataSource={snapshot.batches} pagination={snapshot.batches.length > 5 ? { pageSize: 5, showSizeChanger: false, hideOnSinglePage: true } : false} locale={{ emptyText: 'Todavía no se han creado bloques de este lote.' }} columns={[
            { title: 'Bloque', render: (_, b) => <b>{String(b.index).padStart(2, '0')}</b>, width: 90 },
            { title: 'Estado de Clef', render: (_, b) => <Tag bordered={false} color={b.running ? 'processing' : b.partial || b.failed ? 'warning' : b.completed === b.total ? 'success' : 'default'}>{b.running ? 'En proceso' : b.pending ? (b.status === 'interrupted' ? 'Interrumpido' : 'Pendiente') : b.failed ? 'Con errores' : b.partial ? 'Con parciales' : 'Completo'}</Tag> },
            { title: 'Clef completas', render: (_, b) => `${b.completed} / ${b.total}`, align: 'center' },
            { title: 'Clef parciales', dataIndex: 'partial', align: 'center' },
            { title: 'Clef fallidas', dataIndex: 'failed', align: 'center' },
            { title: 'Resultados', render: (_, b) => <a href={`${base}/comparacion?sample=${encodeURIComponent(b.id)}&reveal=1`} target="_blank" rel="noopener noreferrer">Ver comparación <RightOutlined /></a> },
          ]} scroll={{ x: 700 }} />
        </section>
        <footer className="monitor-footer"><span>Última actividad guardada: <b>{time(snapshot.activity)}</b></span><span>Este monitor muestra estados guardados; no verifica directamente el proceso del servidor.</span></footer>
      </>}
    </main>
  </div>;
}
function Count({ title, value, text, tone, icon }) { return <article className={`count-card count-${tone}`}><div><span>{title}</span>{icon}</div><strong>{number(value)}</strong><p>{text}</p></article>; }

let base, routeError;
try { base = portalBase(window.location.pathname); } catch (error) { routeError = error; }
createRoot(document.getElementById('root')).render(<ConfigProvider theme={{ token: { colorPrimary: '#167963', colorInfo: '#167963', fontFamily: '"Instrument Sans", sans-serif', colorText: '#19251f', colorBorder: '#dce4d9', borderRadius: 10 }, components: { Button: { primaryShadow: 'none' }, Table: { headerBg: '#f4f7f2', rowHoverBg: '#f6f9f5' } } }}>{routeError ? <Alert type="error" message={routeError.message} /> : <Monitor base={base} />}</ConfigProvider>);
