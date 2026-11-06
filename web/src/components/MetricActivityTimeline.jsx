import { dailyMessageActivity, metricEvidenceInterval } from '../services/metricPresentation';
import { metricTimeText } from '../services/dailyMetrics';
import './MetricActivityTimeline.css';

const rows = [
  { actor: 'cliente', label: 'Cliente' },
  { actor: 'bot', label: 'Bot' },
  { actor: 'humano', label: 'Persona' },
];

function preciseTime(timestamp, timezone) {
  if (!timestamp || !timezone || !Number.isFinite(Date.parse(timestamp))) return 'Hora no disponible';
  try {
    return new Intl.DateTimeFormat('es-HN', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(timestamp));
  } catch { return 'Hora no disponible'; }
}

export default function MetricActivityTimeline({ conversation, day, timezone, firstResponse }) {
  const activity = dailyMessageActivity(conversation, day, timezone);
  const interval = metricEvidenceInterval(firstResponse, conversation, day, timezone);
  const counts = Object.fromEntries(rows.map(({ actor }) => [actor, activity.filter(message => message.actor === actor).length]));
  const evidenceIds = new Set((firstResponse?.result?.evidence || []).map(item => String(item.messageId)));
  const start = Date.parse(day?.firstMessageAt), end = Date.parse(day?.lastMessageAt);
  const position = timestamp => end === start ? 50 : (Date.parse(timestamp) - start) / (end - start) * 100;
  const waitStart = interval ? position(interval.from) : null;
  const waitEnd = interval ? position(interval.to) : null;
  const firstTime = metricTimeText(day?.firstMessageAt, timezone);
  const lastTime = metricTimeText(day?.lastMessageAt, timezone);
  const description = `${counts.cliente} mensajes del cliente, ${counts.bot} del bot y ${counts.humano} de una persona, entre ${firstTime} y ${lastTime}. Los mensajes simultáneos pueden superponerse.${interval ? ` La franja señala la espera desde ${preciseTime(interval.from, timezone)} hasta la primera respuesta humana a las ${preciseTime(interval.to, timezone)}.` : ''}`;

  return <section className="metric-activity-timeline" aria-label="Actividad de los mensajes del día">
    <header className="mat-heading">
      <div><h4>Actividad de los mensajes</h4><span>{activity.length ? 'Cada punto representa un mensaje' : 'Intervalo observado'}</span></div>
      {interval && <div className="mat-wait-key"><i aria-hidden="true" /><span>Hasta la primera respuesta humana<b>{preciseTime(interval.from, timezone)} <span aria-hidden="true">→</span> {preciseTime(interval.to, timezone)}</b></span></div>}
    </header>
    {activity.length ? <div className="mat-chart" role="img" aria-label={description}>
      <div className="mat-row-labels" aria-hidden="true">{rows.map(row => <div key={row.actor}><i className={`mat-role-dot mat-role-${row.actor}`} /><span>{row.label}</span><b>{counts[row.actor]}</b></div>)}</div>
      <div className="mat-plot" aria-hidden="true">
        {interval && <><div className="mat-wait-band" style={{ left: `${waitStart}%`, width: `${waitEnd - waitStart}%` }} /><div className="mat-response-line" style={{ left: `${waitEnd}%` }} /></>}
        {rows.map(row => <div className="mat-track" key={row.actor}>{activity.filter(message => message.actor === row.actor).map((message, index) => <i key={`${message.id}-${index}`} className={`mat-point mat-role-${row.actor}${row.actor === 'humano' && interval && Date.parse(message.timestamp) === Date.parse(interval.to) && evidenceIds.has(String(message.id)) ? ' mat-first-human' : ''}`} style={{ left: `${message.position * 100}%` }} title={`${row.label} · ${preciseTime(message.timestamp, timezone)}`} />)}</div>)}
      </div>
      <div className="mat-axis" aria-hidden="true"><span><b>{firstTime}</b>Primer mensaje</span><span><b>{lastTime}</b>Último mensaje</span></div>
    </div> : <div className="mat-empty"><div className="mat-empty-interval"><span><b>{firstTime}</b>Primer mensaje</span><i aria-hidden="true" /><span><b>{lastTime}</b>Último mensaje</span></div><p>No hay mensajes disponibles para dibujar la actividad.</p></div>}
  </section>;
}
