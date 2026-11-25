import { conversationClock } from '../services/conversationTime';
import { countryLabel } from '../services/presentationText';
import { flagCount, evaluationStatus } from '../services/flags';
import { defaultDateRange } from '../services/dateRange';
import { conversationLink } from '../services/conversationNavigation';
import { reviewSelectionId, selectedReview, reviewSelectionSourceNote } from '../services/reviewSelection';
import { summaryRangeLabel } from '../services/summaryPresentation';
import { bothModelsComplete, hasModelCoverage } from '../services/summaryFilters';
import { useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Input, Table, Tag } from 'antd';
import { ArrowRightOutlined, SearchOutlined } from '@ant-design/icons';
import { useApi, useDebounced, usePortal } from '../hooks';
import { queryString } from '../services/api';
import { PageHeading, Filters, ErrorState, EmptyState, Marks, PriorityTag, Mark, tableLoading, dateText } from '../components/common';

export default function Conversations({ search = false }) {
  const { bootstrap } = usePortal();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const selection = selectedReview(params, bootstrap.reviewSelection);
  useEffect(() => {
    if (selection && params.get('dateBasis') === 'started') setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set('dateBasis', 'activity');
      return next;
    }, { replace: true });
  }, [selection, params, setParams]);
  const query = params.get('q') || '';
  const setQuery = q => setParams(queryString({ ...Object.fromEntries(params), q, page: 1 }), { replace: true });
  const debounced = useDebounced(query);
  const dateBasis = !selection && params.get('dateBasis') === 'started' ? 'started' : 'activity';
  const defaults = selection || defaultDateRange(dateBasis === 'activity' ? bootstrap.activityDateRange?.max : bootstrap.dateRange.max, bootstrap.timezone);
  const bothComplete = params.get('completion') === 'both';
  const value = { from: params.get('from') ?? defaults.from, to: params.get('to') ?? defaults.to, dateBasis, completion: bothComplete ? 'both' : undefined, reviewSelection: params.get('reviewSelection') || undefined, country: params.get('country') || '', agent: params.get('agent') || '', classification: params.get('classification') || ({ P1: 'critical', P2: 'normal' }[params.get('priority')] || 'all'), agreement: params.get('agreement') || 'all', status: params.get('status') || 'all', variable: params.get('variable') || '', page: Number(params.get('page')) || 1, pageSize: Number(params.get('pageSize')) || 15 };
  const invalidRange = value.from && value.to && value.from > value.to;
  const request = useApi(invalidRange ? null : `${search ? '/search' : '/conversations'}?${queryString({ ...value, q: debounced, reviewSelection: reviewSelectionId(params) })}`);
  const coverageUnavailable = bothComplete && !request.loading && request.data?.items?.some(item => !hasModelCoverage(item) || !bothModelsComplete(item));
  const update = next => setParams(queryString({ ...next, q: query }), { replace: true });
  const open = c => navigate(conversationLink(c.id, `${location.pathname}${location.search}`, c.excerpt?.messageId));
  const columns = [
    { title: 'CLIENTE / CONVERSACIÓN', key: 'client', width: 230, render: (_, c) => <button className="table-client" onClick={() => open(c)}><b>{c.client.name}{c.client.phoneLast4 && <span className="masked-phone"> …{c.client.phoneLast4}</span>}</b><span className="mono small muted">{c.id}</span></button> },
    { title: 'ASISTENTE DE VENTA', key: 'agent', width: 210, render: (_, c) => <div className="table-stack"><span>{c.agent.name}</span><span className="small muted">{countryLabel(c.country, c.countryName)} <span className="country-code small-code">{c.country}</span></span></div> },
    { title: dateBasis === 'activity' ? selection ? 'DÍA DE SELECCIÓN' : 'ÚLTIMA ACTIVIDAD' : 'FECHA DE INICIO', key: 'date', width: 150, render: (_, c) => <div className="table-stack" title={`${selection && dateBasis === 'activity' ? 'Fecha y hora guardadas al seleccionar la conversación. ' : ''}${conversationClock(c).label}`}><span>{selection && dateBasis === 'activity' ? dateText(c.displayDate) : conversationClock(c).date(c.displayAt || c.startedAt)}</span><span className="mono small muted">{conversationClock(c).time(c.displayAt || c.startedAt)} · {c.channel}</span></div> },
    { title: 'FLAGS DE ATENCIÓN', key: 'priority', width: 180, render: (_, c) => <div className="priority-cell">{flagCount(c, 'critical') > 0 && <PriorityTag priority="critical" count={flagCount(c, 'critical')} />}{flagCount(c, 'normal') > 0 && <PriorityTag priority="normal" count={flagCount(c, 'normal')} />}{!flagCount(c, 'critical') && !flagCount(c, 'normal') && <span className="muted">—</span>}</div> },
    { title: 'POSITIVOS', key: 'positive', width: 115, render: (_, c) => flagCount(c, 'positive') > 0 ? <span className="positive-count"><Mark kind="positive" />{flagCount(c, 'positive')}</span> : <span className="muted">{evaluationStatus(c) === 'evaluated' ? '0' : '—'}</span> },
    { title: 'RESULTADOS', key: 'marks', render: (_, c) => <Marks conversation={c} /> },
    { title: '', key: 'open', width: 90, render: (_, c) => <Button type="text" aria-label={`Abrir conversación de ${c.client.name} ${c.id}`} onClick={() => open(c)} icon={<ArrowRightOutlined />} /> },
  ];
  return <div><PageHeading eyebrow={search ? 'EXPLORAR EL HISTÓRICO' : 'CONVERSACIONES'} title={search ? 'Encuentra la conversación' : 'Histórico de conversaciones'} description={search ? 'Busca mensajes y resultados. Los flags automáticos requieren coincidencia de ambos modelos.' : 'Flags automáticos con coincidencia de ambos modelos y revisiones humanas.'} />{selection && <Alert style={{ marginBottom: 16 }} type="info" showIcon message="Selección para revisión" description={`${summaryRangeLabel(selection.from, selection.to)} · ${selection.count} conversaciones. ${reviewSelectionSourceNote(selection)}`} action={<Button size="small" onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.delete('reviewSelection'); next.set('page', '1'); return next; }, { replace: true })}>Quitar selección</Button>} />}<div className={search ? 'search-hero' : 'history-search'}><Input size="large" prefix={<SearchOutlined />} value={query} allowClear placeholder={search ? 'Busca un mensaje, cliente, asistente o evento…' : 'Buscar cliente, código o asistente…'} aria-label={search ? 'Buscar en conversaciones y mensajes' : 'Buscar en el histórico'} onChange={e => { setQuery(e.target.value); }} />{search && <div className="search-suggestions"><span className="muted small">Prueba con</span>{['cancelar', 'supervisor', 'Karla', 'entrega'].map(term => <button key={term} onClick={() => setQuery(term)}>{term}</button>)}</div>}</div>{bothComplete && <Alert style={{ marginBottom: 12 }} type="info" showIcon message="Ambos modelos completos" description="El listado conserva el período y la cobertura elegidos en el resumen." action={<Button size="small" onClick={() => update({ ...value, completion: undefined, page: 1 })}>Quitar filtro</Button>} />}<Filters value={value} onChange={update} withStatus withVariable />{coverageUnavailable ? <Alert type="warning" showIcon message="No se pudo verificar la revisión de ambos modelos" description="Actualiza el listado para consultar su cobertura completa." action={<Button onClick={request.reload}>Actualizar</Button>} /> : request.error ? <ErrorState error={request.error} retry={request.reload} /> : <section className="table-panel"><div className="table-panel-head"><h2>{search ? 'Resultados de búsqueda' : selection ? 'Conversaciones seleccionadas' : 'Todas las conversaciones'}</h2><span className="muted small">{invalidRange ? 'Corrige el rango de fechas' : request.loading ? 'Cargando conversaciones…' : `${request.data?.total || 0}${selection ? ` de ${selection.count}` : ''} conversaciones${debounced ? ` para “${debounced}”` : ''}`}</span></div><Table rowKey="id" columns={columns} dataSource={invalidRange ? [] : request.data?.items || []} loading={tableLoading(request.loading)} scroll={{ x: 940 }} pagination={{ current: value.page, pageSize: value.pageSize, total: request.data?.total || 0, showSizeChanger: true, pageSizeOptions: [15, 30, 60], showTotal: total => `${total} conversaciones`, onChange: (page, pageSize) => update({ ...value, page, pageSize }) }} locale={{ emptyText: request.loading ? null : <EmptyState title={search && debounced ? 'No encontramos coincidencias' : 'No hay conversaciones'} description={search && debounced ? 'Prueba otras palabras o amplía los filtros.' : 'Ajusta el período o los filtros para ver otras conversaciones.'} /> }} expandable={search ? { expandedRowRender: c => <div className="search-excerpt"><span className="eyebrow">MENSAJE COINCIDENTE · {c.excerpt?.actor === 'humano' ? 'ASISTENTE' : c.excerpt?.actor?.toUpperCase()}</span><p>“{c.excerpt?.text}”</p><Button type="link" onClick={() => open(c)}>Ver mensaje en contexto <ArrowRightOutlined /></Button></div>, rowExpandable: c => !!c.excerpt, defaultExpandAllRows: false } : undefined} /></section>}</div>;
}
