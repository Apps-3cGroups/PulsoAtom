import { Alert, Button, Empty, Select, Input, Tag, Tooltip } from 'antd';
import { ReloadOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { usePortal } from '../hooks';

let TZ = 'America/Tegucigalpa';
export function setDisplayTimezone(timezone) { TZ = timezone || 'America/Tegucigalpa'; }
export const dateText = (value, options = {}) => value ? new Intl.DateTimeFormat('es-HN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ, ...options }).format(new Date(value.length === 10 ? `${value}T12:00:00-06:00` : value)) : 'Sin carga';
export const timeText = value => value ? new Intl.DateTimeFormat('es-HN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }).format(new Date(value)) : '—';
export function previousDate(date, days) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() - days); return value.toISOString().slice(0, 10); }
export function Brand({ compact = false, animated = false }) {
  return <span className={`brand${animated ? ' brand-animated' : ''}`}><svg width="25" height="30" viewBox="0 0 25 30" aria-hidden="true"><rect x="4" y="1" width="17" height="28" rx="6" fill="var(--surface-raised)" stroke="var(--border-strong)"/>{animated && <circle className="brand-dot-halo" cx="12.5" cy="10" r="4.4" fill="none" stroke="var(--p1)" strokeWidth="1" />}<circle className="brand-red-dot" cx="12.5" cy="10" r="4.4" fill="var(--p1)"/><circle cx="12.5" cy="21" r="3.2" fill="none" stroke="var(--muted)" strokeWidth="1.7"/></svg>{!compact && <b>Pulso<span className="brand-period">.</span></b>}</span>;
}
const markNames = { p1: 'P1 del sistema', p2: 'P2 del sistema', human: 'Levantado por humano', refuted: 'Refutado por humano', coaching: 'Coaching', media: 'Multimedia' };
export function Mark({ kind, label, small = false }) { return <span className={`mark mark-${kind} ${small ? 'mark-small' : ''}`} role="img" aria-label={label || markNames[kind]} />; }
export function PriorityTag({ priority, count }) { return <span className={`priority-tag ${priority.toLowerCase()}`}>{count !== undefined ? `${count} ` : ''}{priority}</span>; }
export function Marks({ conversation, limit = 5 }) { return <span className="marks-inline">{conversation.marks.slice(0, limit).map(m => <Tooltip key={m.id} title={`${m.name}${m.priority ? ` · ${m.priority}` : ''}`}><span><Mark kind={m.kind} /></span></Tooltip>)}{conversation.marks.length > limit && <span className="small muted">+{conversation.marks.length - limit}</span>}{conversation.media.length > 0 && <Tooltip title={`Multimedia: ${conversation.media.join(', ')}`}><span><Mark kind="media" /></span></Tooltip>}{!conversation.evaluated && <Tag className="neutral-tag">No evaluada</Tag>}{conversation.evaluated && !conversation.marks.length && !conversation.media.length && <span className="muted small">Sin flags</span>}</span>; }
export function PageHeading({ eyebrow, title, description, actions }) { return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</div>; }
export function ErrorState({ error, retry }) { return <div className="state-box"><Alert type="error" showIcon message="No pudimos cargar esta información" description={error?.message || 'Intenta nuevamente.'} action={retry && <Button onClick={retry} icon={<ReloadOutlined />}>Reintentar</Button>} /></div>; }
export function LoadingState({ fullScreen = false }) { return <div className={`pulso-loader${fullScreen ? ' pulso-loader-fullscreen' : ' loading-panel'}`} role="status" aria-label="Cargando Pulso" aria-busy="true"><Brand animated /><span className="pulso-loader-caption">Cargando información…</span></div>; }
export function EmptyState({ title = 'No hay conversaciones en este período', description = 'Prueba con otro rango de fechas o ajusta los filtros.', action }) { return <div className="empty-panel"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>{title}</strong><p>{description}</p></>}>{action}</Empty></div>; }
export function Filters({ value, onChange, withPriority = true, withStatus = false, withVariable = false }) {
  const { bootstrap } = usePortal();
  const patch = update => onChange({ ...value, ...update, page: 1 });
  const invalidRange = value.from && value.to && value.from > value.to;
  return <div className="filter-panel">
    <div className="filter-field date-filter"><label htmlFor="date-from">Desde</label><Input id="date-from" aria-label="Fecha inicial" type="date" value={value.from || ''} onChange={e => patch({ from: e.target.value })} status={invalidRange ? 'error' : undefined} /></div>
    <div className="filter-field date-filter"><label htmlFor="date-to">Hasta</label><Input id="date-to" aria-label="Fecha final" type="date" value={value.to || ''} onChange={e => patch({ to: e.target.value })} status={invalidRange ? 'error' : undefined} /></div>
    <div className="filter-field"><label>País</label><Select aria-label="Filtrar por país" value={value.country || 'all'} onChange={country => patch({ country: country === 'all' ? undefined : country, agent: undefined })} options={[{ value: 'all', label: 'Todos los países' }, ...bootstrap.countries.map(c => ({ value: c.code, label: c.name }))]} /></div>
    <div className="filter-field agent-filter"><label>Asistente de venta</label><Select aria-label="Filtrar por asistente de venta" value={value.agent || undefined} placeholder="Todos los asistentes" allowClear showSearch optionFilterProp="label" onChange={agent => patch({ agent })} options={bootstrap.agents.filter(a => !value.country || a.country === value.country).map(a => ({ value: a.id, label: a.name }))} /></div>
    {withPriority && <div className="filter-field"><label>Prioridad</label><Select aria-label="Filtrar por prioridad" value={value.priority || 'all'} onChange={priority => patch({ priority })} options={[{ value: 'all', label: 'Todas' }, { value: 'P1', label: 'P1 · Prioridad alta' }, { value: 'P2', label: 'P2 · Atención' }]} /></div>}
    {withStatus && <div className="filter-field"><label>Evaluación</label><Select aria-label="Filtrar por evaluación" value={value.status || 'all'} onChange={status => patch({ status })} options={[{ value: 'all', label: 'Todas' }, { value: 'evaluated', label: 'Evaluadas' }, { value: 'pending', label: 'No evaluadas' }]} /></div>}
    {withVariable && <div className="filter-field wide-filter"><label>Variable</label><Select aria-label="Filtrar por variable" value={value.variable || undefined} placeholder="Todas las variables" allowClear showSearch optionFilterProp="label" onChange={variable => patch({ variable })} options={bootstrap.catalog.map(v => ({ value: v.id, label: v.name }))} /></div>}
    {invalidRange && <span className="filter-error" role="alert">La fecha inicial debe ser anterior o igual a la final.</span>}
  </div>;
}
export function TextLink({ children, onClick }) { return <Button type="link" className="text-link" onClick={onClick}>{children}<ArrowRightOutlined /></Button>; }
