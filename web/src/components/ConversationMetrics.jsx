import { Popover, Select, Tooltip } from 'antd';
import { ArrowRightOutlined, CalendarOutlined, ClockCircleOutlined, CommentOutlined, FieldTimeOutlined, InfoCircleOutlined, MessageOutlined, UserOutlined } from '@ant-design/icons';
import { metricValue, conversationMetricIds } from '../services/flags';
import { dailyMetricsView, metricDateText, metricTimeText } from '../services/dailyMetrics';
import { dailyMessageActivity, durationLabel, durationParts, metricEvidenceInterval } from '../services/metricPresentation';

const numeric = value => new Intl.NumberFormat('es-HN', { maximumFractionDigits: 2 }).format(value);
function Explain({ label, children }) {
  return <Tooltip title={children}><button type="button" className="metric-explain" aria-label={`Cómo se calcula: ${label}`}><InfoCircleOutlined /></button></Tooltip>;
}
function Duration({ value }) {
  const parts = durationParts(value);
  return <div className="conversation-metric-number" aria-label={durationLabel(value)}>{parts ? parts.map(part => <span className="metric-time-part" key={part.unit}><strong>{numeric(part.value)}</strong><span>{part.unit}</span></span>) : <span className="metric-unavailable">No disponible</span>}</div>;
}
function ActivityTrace({ conversation, day, timezone }) {
  const activity = dailyMessageActivity(conversation, day, timezone);
  const time = timestamp => metricTimeText(timestamp, timezone);
  return <div className="metric-activity-trace">
    <span className="metric-trace-title">{activity.length ? 'Mensajes a lo largo del día' : 'Intervalo observado'}</span>
    {activity.length ? <svg viewBox="0 0 280 64" role="img" aria-label={`${activity.filter(m => m.actor === 'cliente').length} mensajes del cliente y ${activity.filter(m => m.actor !== 'cliente').length} del equipo entre ${time(day.firstMessageAt)} y ${time(day.lastMessageAt)}`}>
      <text x="0" y="19">Cliente</text><text x="0" y="49">Equipo</text>
      <path d="M57 15H273M57 45H273" className="metric-trace-line" />
      {activity.map((m, i) => <circle key={`${m.id}-${i}`} cx={60 + m.position * 210} cy={m.actor === 'cliente' ? 15 : 45} r="3.5" className={m.actor === 'cliente' ? 'trace-client' : 'trace-team'} />)}
    </svg> : <div className="metric-interval-line" aria-hidden="true"><i /><span /><i /></div>}
    <div className="metric-trace-times"><span><b>{time(day.firstMessageAt)}</b>Primer mensaje</span><span><b>{time(day.lastMessageAt)}</b>Último mensaje</span></div>
  </div>;
}
function ResponseCard({ id, label, subtitle, icon, variable, conversation, day, timezone }) {
  const value = metricValue(variable);
  const interval = metricEvidenceInterval(variable, conversation, day, timezone);
  const reason = variable?.result?.reason || 'No hay datos suficientes para medir esta espera.';
  return <article className="metric-response-card" aria-labelledby={`metric-title-${id}`}>
    <div className="metric-card-top"><span className="metric-card-icon">{icon}</span><Explain label={label}>{reason}</Explain></div>
    <h3 id={`metric-title-${id}`}>{label}</h3><Duration value={value} />
    <p className="metric-card-caption">{value === null ? reason : subtitle}</p>
    {value !== null && <div className="metric-response-journey"><span><UserOutlined /><span>Cliente{interval && <b>{metricTimeText(interval.from, timezone)}</b>}</span></span><ArrowRightOutlined /><span><CommentOutlined /><span>Persona{interval && <b>{metricTimeText(interval.to, timezone)}</b>}</span></span></div>}
  </article>;
}
function Participation({ assistant, client }) {
  const available = assistant !== null && client !== null;
  const total = available ? assistant + client : null;
  const teamShare = total > 0 ? assistant / total : 0;
  return <article className="metric-participation-card">
    <div className="metric-card-top"><span className="metric-card-icon"><MessageOutlined /></span><Explain label="Mensajes del día">Cuenta los mensajes del cliente y del equipo (personas y bot). Excluye eventos del sistema. Las proporciones muestran participación, no calidad de atención.</Explain></div>
    <h3>Quién escribió</h3>
    <div className="metric-participation-visual">
      <div className="metric-message-ring" role="img" aria-label={available ? `${numeric(total)} ${total === 1 ? 'mensaje' : 'mensajes'}: ${numeric(client)} del cliente y ${numeric(assistant)} del equipo` : 'Distribución de mensajes no disponible'}>
        <svg viewBox="0 0 132 132" aria-hidden="true"><circle cx="66" cy="66" r="55" className="metric-ring-base" />{total > 0 && <><circle cx="66" cy="66" r="55" pathLength="100" className="metric-ring-client" /><circle cx="66" cy="66" r="55" pathLength="100" strokeDasharray={`${teamShare * 100} 100`} className="metric-ring-team" /></>}</svg>
        <div><strong>{total === null ? '—' : numeric(total)}</strong><span>{total === 1 ? 'mensaje' : 'mensajes'}</span></div>
      </div>
      <div className="metric-participation-legend"><div><i className="client-dot" /><span>Cliente</span><strong>{client === null ? '—' : numeric(client)}</strong></div><div><i className="team-dot" /><span>Equipo<small>Personas + bot</small></span><strong>{assistant === null ? '—' : numeric(assistant)}</strong></div></div>
    </div>
    <p className="metric-card-caption">{!available ? 'Faltan datos para mostrar la distribución.' : total === 0 ? 'Sin mensajes contabilizados.' : client > assistant ? 'El cliente envió más mensajes.' : assistant > client ? 'El equipo envió más mensajes.' : 'Cliente y equipo enviaron la misma cantidad.'}</p>
  </article>;
}

export default function ConversationMetrics({ conversation, selectedDate, onDateChange }) {
  const view = dailyMetricsView(conversation.dailyMetrics, selectedDate);
  const day = view.selectedDay;
  const variables = (Array.isArray(day?.metrics) ? day.metrics : []).filter(v => conversationMetricIds.includes(v.id));
  const byId = new Map(variables.map(v => [v.id, v]));
  const get = id => byId.get(id);
  const value = id => metricValue(get(id));
  const pending = day?.pendingHumanWait;
  const crossDayWaits = Array.isArray(day?.crossDayWaits) ? day.crossDayWaits : [];
  const available = !!day && !view.unavailableReason;
  const time = timestamp => metricTimeText(timestamp, view.timezone);
  const ratio = value('ratio_mensajes_asistente_entre_cliente'), turn = value('num_mensajes_por_turno_asistente');
  const duration = value('min_duracion_conversacion');
  const explanation = <div className="metric-help-content"><p>Las cifras corresponden solo al día seleccionado. La transcripción y el checklist conservan su alcance original.</p><p>El tiempo transcurrido incluye pausas. La espera más larga solo considera intervalos que terminaron con una respuesta humana dentro del día.</p><p>Las esperas pendientes se observan hasta el último mensaje disponible; no avanzan con la hora actual.</p><p>{variables.filter(v => metricValue(v) !== null).length} de 7 métricas disponibles · Calculadas por código.</p>{view.timezone && <p>Zona horaria: {view.timezone}.</p>}</div>;
  return <section className="conversation-metrics" aria-label="Métricas del día de actividad">
    <header><div><span className="eyebrow">LA CONVERSACIÓN EN CIFRAS</span><h2>Así fue este día</h2><p className="metric-day-summary" aria-live="polite" aria-atomic="true">{available ? <><b>{metricDateText(day.date)}</b><span>·</span>{day.messageCount} {day.messageCount === 1 ? 'mensaje' : 'mensajes'}<span>·</span>{time(day.firstMessageAt)}–{time(day.lastMessageAt)}</> : 'Consulta la actividad registrada en esta conversación.'}</p></div><div className="metric-day-controls"><label htmlFor="conversation-metric-day"><CalendarOutlined /> Día de actividad</label><Select id="conversation-metric-day" aria-label="Día de actividad" value={view.selectedDate || undefined} onChange={onDateChange} disabled={!view.days.length} placeholder="Sin días disponibles" options={view.days.map(item => ({ value: item.date, label: metricDateText(item.date) }))} /></div></header>
    {available ? <>
      <div className="metric-overview-grid" key={day.date}>
        <article className="metric-feature-card"><div className="metric-card-top"><span className="metric-card-icon"><ClockCircleOutlined /></span><span className="metric-scope-pill">Incluye pausas</span></div><h3>Tiempo transcurrido</h3><Duration value={duration} /><p className="metric-card-caption">{duration === null ? get('min_duracion_conversacion')?.result?.reason || 'No hay datos suficientes.' : 'Del primer al último mensaje de este día.'}</p><ActivityTrace conversation={conversation} day={day} timezone={view.timezone} /></article>
        <ResponseCard id="first" label="Primera respuesta humana" subtitle="Del primer mensaje del cliente a la respuesta humana." icon={<CommentOutlined />} variable={get('min_primera_respuesta_humano')} conversation={conversation} day={day} timezone={view.timezone} />
        <ResponseCard id="longest" label="Espera más larga con respuesta" subtitle={value('min_primera_respuesta_humano') !== null && value('min_primera_respuesta_humano') === value('min_silencio_max_humano') ? 'La primera respuesta fue también la espera más larga.' : 'Mayor espera atendida dentro del día.'} icon={<FieldTimeOutlined />} variable={get('min_silencio_max_humano')} conversation={conversation} day={day} timezone={view.timezone} />
        <Participation assistant={value('num_mensajes_asistente')} client={value('num_mensajes_cliente')} />
      </div>
      <div className="metric-rhythm-strip">
        <div><span className="metric-rhythm-icon"><CommentOutlined /></span><div><span className="metric-rhythm-label">Por cada mensaje del cliente</span><p><strong>{ratio === null ? '—' : numeric(ratio)}</strong><span>{ratio === null ? 'Relación no disponible' : 'mensajes del equipo'}</span></p></div><Explain label="Relación de mensajes">{get('ratio_mensajes_asistente_entre_cliente')?.result?.reason || 'Mensajes del equipo divididos entre mensajes del cliente. Si no hay mensajes del cliente, no se calcula.'}</Explain></div>
        <div><span className="metric-rhythm-icon"><MessageOutlined /></span><div><span className="metric-rhythm-label">En cada turno del equipo</span><p><strong>{turn === null ? '—' : numeric(turn)}</strong><span>{turn === null ? 'Promedio no disponible' : 'mensajes seguidos, en promedio'}</span></p></div><Explain label="Mensajes por turno">{get('num_mensajes_por_turno_asistente')?.result?.reason || 'Un turno reúne los mensajes seguidos del equipo antes de que vuelva a escribir el cliente.'}</Explain></div>
      </div>
      {pending && <div className="metric-pending-banner" role="note"><span className="metric-pending-icon"><ClockCircleOutlined /></span><div><b>Quedó un mensaje sin respuesta humana</b><p>{pending.observedMinutes > 0 ? <>{durationLabel(pending.observedMinutes)} de espera observada · </> : null}Sin respuesta humana hasta las {time(pending.observedThrough)}, último dato disponible.</p></div><span className="metric-pending-label">Pendiente al corte</span></div>}
    </> : <div className="metric-day-empty"><InfoCircleOutlined /><div><b>Métricas diarias no disponibles</b><p>{view.unavailableReason}</p></div></div>}
    <footer className="metric-day-footer"><span>{crossDayWaits.length > 0 ? <Tooltip title={crossDayWaits.map(wait => `${metricDateText(wait.startDate)} → ${metricDateText(wait.responseDate)}: continuidad no confirmada. No se suma a las esperas del día.`).join(' ')}><span className="metric-cross-day-note" tabIndex={0}><InfoCircleOutlined />Hay mensajes en días distintos. Las esperas se miden dentro de cada día.</span></Tooltip> : 'El día seleccionado solo cambia estas cifras.'}</span><Popover title="Cómo leer estas cifras" content={explanation} trigger="click" placement="topRight"><button type="button" className="metric-help-button" aria-label="Cómo leer estas cifras"><InfoCircleOutlined aria-hidden="true" />Cómo leer estas cifras</button></Popover></footer>
  </section>;
}
