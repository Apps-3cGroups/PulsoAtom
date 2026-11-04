import { flagCount } from '../services/flags';
import { defaultDateRange } from '../services/dateRange';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Input, Table, Tag } from 'antd';
import { ArrowRightOutlined, SearchOutlined } from '@ant-design/icons';
import { useApi, useDebounced, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { PageHeading, Filters, ErrorState, EmptyState, Marks, PriorityTag, Mark, dateText, timeText, tableLoading } from '../components/common';

export default function Conversations({ search = false }) {
  const { bootstrap } = usePortal();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') || '';
  const setQuery = q => setParams(queryString({ ...Object.fromEntries(params), q, page: 1 }), { replace: true });
  const debounced = useDebounced(query);
  const dateBasis = params.get('dateBasis') === 'activity' ? 'activity' : 'started';
  const defaults = defaultDateRange(dateBasis === 'activity' ? bootstrap.activityDateRange?.max : bootstrap.dateRange.max, bootstrap.timezone);
  const value = { from: params.get('from') ?? defaults.from, to: params.get('to') ?? defaults.to, dateBasis, country: params.get('country') || '', agent: params.get('agent') || '', classification: params.get('classification') || ({ P1: 'critical', P2: 'normal' }[params.get('priority')] || 'all'), agreement: params.get('agreement') || 'all', status: params.get('status') || 'all', variable: params.get('variable') || '', page: Number(params.get('page')) || 1, pageSize: Number(params.get('pageSize')) || 15 };
  const invalidRange = value.from && value.to && value.from > value.to;
  const request = useApi(invalidRange ? null : `${search ? '/search' : '/conversations'}?${queryString({ ...value, q: debounced })}`);
  const update = next => setParams(queryString({ ...next, q: query }), { replace: true });
  const open = c => navigate(`/conversacion/${encodeURIComponent(c.id)}${c.excerpt ? `?message=${encodeURIComponent(c.excerpt.messageId)}` : ''}`);
  const columns = [
    { title: 'CLIENTE / CONVERSACIÓN', key: 'client', width: 230, render: (_, c) => <button className="table-client" onClick={() => open(c)}><b>{c.client.name}{c.client.phoneLast4 && <span className="masked-phone"> …{c.client.phoneLast4}</span>}</b><span className="mono small muted">{c.id}</span></button> },
    { title: 'ASISTENTE DE VENTA', key: 'agent', width: 210, render: (_, c) => <div className="table-stack"><span>{c.agent.name}</span><span className="small muted">{c.countryName} <span className="country-code small-code">{c.country}</span></span></div> },
    { title: dateBasis === 'activity' ? 'ÚLTIMA ACTIVIDAD' : 'FECHA DE INICIO', key: 'date', width: 150, render: (_, c) => <div className="table-stack"><span>{dateText(c.displayDate || c.date, { year: undefined })}</span><span className="mono small muted">{timeText(c.displayAt || c.startedAt)} · {c.channel}</span></div> },
    { title: 'FLAGS DE ATENCIÓN', key: 'priority', width: 180, render: (_, c) => <div className="priority-cell">{flagCount(c, 'critical') > 0 && <PriorityTag priority="critical" count={flagCount(c, 'critical')} />}{flagCount(c, 'normal') > 0 && <PriorityTag priority="normal" count={flagCount(c, 'normal')} />}{!flagCount(c, 'critical') && !flagCount(c, 'normal') && <span className="muted">—</span>}</div> },
    { title: 'POSITIVOS', key: 'positive', width: 115, render: (_, c) => flagCount(c, 'positive') > 0 ? <span className="positive-count"><Mark kind="positive" />{flagCount(c, 'positive')}</span> : <span className="muted">{c.evaluated && !c.evaluationIncomplete ? '0' : '—'}</span> },
    { title: 'RESULTADOS', key: 'marks', render: (_, c) => <Marks conversation={c} /> },
    { title: '', key: 'open', width: 90, render: (_, c) => <Button type="text" aria-label={`Abrir conversación de ${c.client.name} ${c.id}`} onClick={() => open(c)} icon={<ArrowRightOutlined />} /> },
  ];
  return <div><PageHeading eyebrow={search ? 'EXPLORAR EL HISTÓRICO' : 'CONVERSACIONES'} title={search ? 'Encuentra la conversación' : 'Histórico de conversaciones'} description={search ? 'Busca en mensajes, clientes, asistentes y eventos detectados.' : 'Consulta lo que ocurrió y revisa cada conversación en su contexto.'} /><div className={search ? 'search-hero' : 'history-search'}><Input size="large" prefix={<SearchOutlined />} value={query} allowClear placeholder={search ? 'Busca un mensaje, cliente, asistente o evento…' : 'Buscar cliente, código o asistente…'} aria-label={search ? 'Buscar en conversaciones y mensajes' : 'Buscar en el histórico'} onChange={e => { setQuery(e.target.value); }} />{search && <div className="search-suggestions"><span className="muted small">Prueba con</span>{['cancelar', 'supervisor', 'Karla', 'entrega'].map(term => <button key={term} onClick={() => setQuery(term)}>{term}</button>)}</div>}</div><Filters value={value} onChange={update} withStatus withVariable />{request.error ? <ErrorState error={request.error} retry={request.reload} /> : <section className="table-panel"><div className="table-panel-head"><h2>{search ? 'Resultados de búsqueda' : 'Todas las conversaciones'}</h2><span className="muted small">{invalidRange ? 'Corrige el rango de fechas' : request.loading ? 'Cargando conversaciones…' : `${request.data?.total || 0} conversaciones${debounced ? ` para “${debounced}”` : ''}`}</span></div><Table rowKey="id" columns={columns} dataSource={invalidRange ? [] : request.data?.items || []} loading={tableLoading(request.loading)} scroll={{ x: 940 }} pagination={{ current: value.page, pageSize: value.pageSize, total: request.data?.total || 0, showSizeChanger: true, pageSizeOptions: [15, 30, 60], showTotal: total => `${total} conversaciones`, onChange: (page, pageSize) => update({ ...value, page, pageSize }) }} locale={{ emptyText: request.loading ? null : <EmptyState title={search && debounced ? 'No encontramos coincidencias' : 'No hay conversaciones'} description={search && debounced ? 'Prueba otras palabras o amplía los filtros.' : 'Ajusta el período o los filtros para ver otras conversaciones.'} /> }} expandable={search ? { expandedRowRender: c => <div className="search-excerpt"><span className="eyebrow">MENSAJE COINCIDENTE · {c.excerpt?.actor === 'humano' ? 'ASISTENTE' : c.excerpt?.actor?.toUpperCase()}</span><p>“{c.excerpt?.text}”</p><Button type="link" onClick={() => open(c)}>Ver mensaje en contexto <ArrowRightOutlined /></Button></div>, rowExpandable: c => !!c.excerpt, defaultExpandAllRows: false } : undefined} /></section>}</div>;
}
