import { actorName } from '../services/participants';
import { Fragment, useMemo, useState } from 'react';
import { Button, Checkbox, Popover, Select, Tooltip } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, CloseOutlined, FlagOutlined } from '@ant-design/icons';
import { classificationOf, flagLabel } from '../services/flags';
import { filterMessageRows, groupFlagOptions } from '../services/messageFlags';
import { EmptyState, FlagSymbol, dateText, timeText } from './common';

const hasTime = value => !!value && Number.isFinite(Date.parse(value));
const messageDate = value => hasTime(value) ? dateText(value) : 'Fecha no disponible';
const messageTime = value => hasTime(value) ? timeText(value) : '—';
const classificationOptions = [
  { value: 'all', label: 'Todas las marcas' },
  { value: 'critical', label: 'Flag crítico' },
  { value: 'normal', label: 'Flag menor' },
  { value: 'positive', label: '+ Positivo' },
  { value: 'human', label: 'Flag humano' },
  { value: 'refuted', label: 'Refutados' },
];

function additionOptions(variables) {
  return ['critical', 'normal', 'positive'].map(classification => ({
    label: flagLabel(classification),
    options: variables.filter(variable => classificationOf(variable) === classification)
      .map(variable => ({ value: variable.id, label: variable.name })),
  })).filter(group => group.options.length);
}

function MarkCard({ variable, messageCount, selected, onSelectFlag, onShowFlag }) {
  const classification = classificationOf(variable);
  const source = variable.kind === 'refuted' ? 'Refutado por humano'
    : variable.kind === 'human' || variable.origin === 'human' ? 'Flag humano'
      : variable.dualDetected ? 'Detectado por ambos modelos' : 'Detectado por la IA';
  return <div className={`message-sidebar-flag${selected ? ' message-sidebar-flag-selected' : ''}`}>
    <button type="button"
      className={`message-flag-card mark-card-${classification}${variable.kind === 'refuted' ? ' mark-card-refuted' : ''}`}
      aria-label={messageCount ? `Resaltar mensajes de ${variable.name}` : `Ver revisión de ${variable.name}, sin mensaje vinculable`}
      aria-pressed={messageCount ? selected : undefined}
      onClick={() => messageCount ? onSelectFlag(variable.id) : onShowFlag(variable.id)}>
      <span className="message-flag-title"><FlagSymbol mark={variable} /><b>{variable.name}</b>
        {variable.dualDetected && variable.kind !== 'refuted' && <small className="message-dual-badge" aria-label="Detectado por ambos modelos">2</small>}
      </span>
      <span className="message-flag-source">{flagLabel(classification)} · {source}</span>
      <span className="message-flag-message-count">{messageCount ? `${messageCount} ${messageCount === 1 ? 'mensaje vinculado' : 'mensajes vinculados'}` : 'Sin mensaje vinculable'}</span>
    </button>
    <Button className="message-flag-review" type="text" size="small" icon={<ArrowRightOutlined />} onClick={() => onShowFlag(variable.id)}
      aria-label={`Ver revisión de ${variable.name}`}>Ver revisión</Button>
  </div>;
}

export default function ConversationTranscript({ conversation, index, eligibleFlags = [], filters,
  onFiltersChange, highlight, onShowFlag, onShowContext, onAddFlag, selectedFlagId, onSelectFlag, onFocusMessage }) {
  const [addingTo, setAddingTo] = useState(null);
  const messages = conversation.messages || [];
  const rows = useMemo(() => filterMessageRows(messages, index, filters), [messages, index, filters]);
  const linkedVariables = useMemo(() => {
    const linkedIds = new Set([...index.byMessage.values()].flat().map(variable => variable.id));
    return index.markedVariables.filter(variable => linkedIds.has(variable.id));
  }, [index]);
  const options = useMemo(() => groupFlagOptions(linkedVariables), [linkedVariables]);
  const eligibleOptions = useMemo(() => additionOptions(eligibleFlags), [eligibleFlags]);
  const flagMessageIds = useMemo(() => {
    const map = new Map();
    for (const message of messages) {
      for (const flag of index.byMessage.get(String(message.id)) || []) {
        const id = String(flag.id);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(String(message.id));
      }
    }
    return map;
  }, [messages, index]);
  const sidebarGroups = useMemo(() => ['critical', 'normal', 'positive', 'refuted'].map(classification => ({
    classification,
    label: classification === 'refuted' ? 'Refutados' : classification === 'positive' ? '+ Positivos' : flagLabel(classification),
    variables: index.markedVariables.filter(variable => variable.kind === 'refuted' ? classification === 'refuted' : classificationOf(variable) === classification),
  })).filter(group => group.variables.length), [index]);
  const selectedFlag = index.markedVariables.find(variable => String(variable.id) === String(selectedFlagId));
  const selectedMessageIds = selectedFlag ? flagMessageIds.get(String(selectedFlag.id)) || [] : [];
  const focusedPosition = Math.max(0, selectedMessageIds.indexOf(String(highlight)));
  const patch = values => { setAddingTo(null); onFiltersChange({ ...filters, ...values }); };
  const reset = () => { setAddingTo(null); onFiltersChange({ onlyMarked: false, variableId: null, classification: 'all' }); };
  const filtered = filters.onlyMarked || !!filters.variableId || (filters.classification && filters.classification !== 'all');
  const disabledReason = !conversation.evaluated ? 'La conversación necesita una evaluación antes de registrar una revisión humana.'
    : conversation.sourceChanged || conversation.evaluation?.sourceChanged ? 'La conversación cambió. Evalúa su contenido actualizado antes de registrar flags.'
      : conversation.rawModelView ? 'Las revisiones humanas se registran en la vista operativa.'
        : 'No hay flags disponibles para levantar. Puedes consultar o revisar las marcas existentes.';

  return <section className="message-workspace" aria-label="Conversación y flags por mensaje">
    <div className="message-toolbar">
      <Checkbox checked={filters.onlyMarked} onChange={event => patch({ onlyMarked: event.target.checked })}>Con marca</Checkbox>
      <Select className="message-flag-filter" aria-label="Filtrar mensajes por flag" placeholder="Todos los flags" value={filters.variableId || undefined}
        allowClear showSearch optionFilterProp="label" options={options} onChange={variableId => patch({ variableId: variableId || null })} />
      <Select className="message-classification-filter" aria-label="Clasificación de las marcas de mensajes" value={filters.classification || 'all'}
        options={classificationOptions} onChange={classification => patch({ classification })} />
      <span className="message-filter-count" role="status" aria-live="polite">{rows.length} de {messages.length} mensajes</span>
      {filtered && <Button type="text" size="small" onClick={reset}>Ver todos</Button>}
    </div>
    {selectedFlag && <div className="message-selected-flag" role="status">
      <span className="message-selected-flag-name"><FlagSymbol mark={selectedFlag} /><b>{selectedFlag.name}</b></span>
      <span className="message-selected-flag-position">{selectedMessageIds.length ? `Mensaje ${focusedPosition + 1} de ${selectedMessageIds.length}` : 'Sin mensaje vinculable'}</span>
      <div className="message-selected-flag-navigation">
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} aria-label="Mensaje anterior del flag seleccionado"
          disabled={!selectedMessageIds.length || focusedPosition === 0} onClick={() => onFocusMessage(selectedMessageIds[focusedPosition - 1])} />
        <Button type="text" size="small" icon={<ArrowRightOutlined />} aria-label="Siguiente mensaje del flag seleccionado"
          disabled={!selectedMessageIds.length || focusedPosition >= selectedMessageIds.length - 1} onClick={() => onFocusMessage(selectedMessageIds[focusedPosition + 1])} />
        <Button type="text" size="small" icon={<CloseOutlined />} aria-label="Quitar selección de flag" onClick={() => onSelectFlag(null)}>Quitar selección</Button>
      </div>
    </div>}
    <div className="message-column-labels" aria-hidden="true"><span>MENSAJES</span><span>FLAGS Y REVISIÓN HUMANA</span></div>
    <div className="message-reading-grid">
      <div className="message-workspace-scroll">
      {!rows.length ? <EmptyState title={messages.length ? 'No hay mensajes con estos filtros' : 'No hay mensajes disponibles'}
        description={messages.length ? 'Selecciona otro flag o vuelve a ver la conversación completa.' : 'La transcripción aparecerá aquí cuando esté disponible.'}
        action={filtered && <Button onClick={reset}>Ver todos los mensajes</Button>} /> : rows.map(({ message, flags }, position) => {
        const day = messageDate(message.timestamp);
        const startDay = position === 0 || day !== messageDate(rows[position - 1].message.timestamp);
        const id = String(message.id);
        const selected = !!selectedFlag && flags.some(variable => String(variable.id) === String(selectedFlag.id));
        return <Fragment key={id}>
          {startDay && <div className="message-day-divider"><span>{day}</span></div>}
          <article id={`message-${id}`} data-message-id={id}
            className={`message-evidence-row${selected || String(highlight) === id ? ' message-row-highlighted' : ''}${String(highlight) === id ? ' message-row-focused' : ''}${flags.length ? ' message-row-marked' : ''}`}>
            <div className={`message-bubble actor-${message.actor}`}>
              <div className="message-bubble-meta"><span className="message-actor"><i aria-hidden="true" /><strong>{actorName(message.actor)}</strong></span><time dateTime={hasTime(message.timestamp) ? message.timestamp : undefined}>{messageTime(message.timestamp)}</time></div>
              <p>{message.text}</p>
            </div>
              <div className="message-row-actions">
                {flags.length > 0 && <span className="message-mark-count">{flags.length} {flags.length === 1 ? 'marca' : 'marcas'}</span>}
                <Popover trigger="click" placement="bottomRight" open={addingTo === id}
                  onOpenChange={open => setAddingTo(open && eligibleFlags.length ? id : null)}
                  title="Añadir un flag humano"
                  content={<div className="message-add-flag-popover"><p>Este mensaje será la evidencia. Explica tu criterio antes de guardar.</p>
                    <Select aria-label={`Seleccionar flag para el mensaje ${id}`} placeholder="Seleccionar un flag" value={undefined} showSearch optionFilterProp="label"
                      options={eligibleOptions} onChange={variableId => {
                        const variable = eligibleFlags.find(item => item.id === variableId);
                        if (variable) { setAddingTo(null); onAddFlag(variable, message.id); }
                      }} />
                  </div>}>
                  <Tooltip title={!eligibleFlags.length ? disabledReason : undefined}><span><Button type="text" size="small" icon={<FlagOutlined />}
                    disabled={!eligibleFlags.length} aria-label={`Añadir flag al mensaje ${id}`}>Añadir flag</Button></span></Tooltip>
                </Popover>
                {filtered && <Button type="text" size="small" onClick={() => onShowContext(message.id)} aria-label={`Ver contexto del mensaje ${id}`}>Ver contexto</Button>}
              </div>
          </article>
        </Fragment>;
      })}
      </div>
      <aside className="message-flags-sidebar" aria-label="Flags de la conversación">
        <header className="message-flags-sidebar-heading"><h3>Flags de la conversación</h3><span>{index.markedVariables.length}</span></header>
        <p className="message-flags-sidebar-hint">Selecciona un flag para resaltar sus mensajes. Abre su revisión para ver la evidencia de cada modelo.</p>
        {!sidebarGroups.length ? <EmptyState title="Sin marcas publicadas" description="Puedes leer la conversación y añadir un flag humano cuando corresponda." />
          : sidebarGroups.map(group => <section className={`message-flag-group message-flag-group-${group.classification}`} key={group.classification} aria-label={group.label}>
            <h4>{group.label}<span>{group.variables.length}</span></h4>
            {group.variables.map(variable => <MarkCard key={variable.id} variable={variable} messageCount={flagMessageIds.get(String(variable.id))?.length || 0}
              selected={String(variable.id) === String(selectedFlagId)} onSelectFlag={onSelectFlag} onShowFlag={onShowFlag} />)}
          </section>)}
        {index.unlinkedVariables.length > 0 && <p className="message-flags-unlinked-note">{conversation.sourceChanged || conversation.evaluation?.sourceChanged
          ? 'El contenido cambió desde la evaluación. Las marcas conservan su revisión, pero no se vinculan a estos mensajes.'
          : 'Las marcas sin mensaje vinculable conservan su revisión. No hay una cita asociada a un mensaje disponible.'}</p>}
      </aside>
    </div>
    <footer className="message-workspace-footer"><span>{conversation.demo ? 'Transcripción sintética para demostración' : 'Mensajes de la conversación original'}</span><span>Flags automáticos por coincidencia de ambos modelos · Revisión humana identificada</span></footer>
  </section>;
}
