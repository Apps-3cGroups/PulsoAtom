import { useState } from 'react';
import { Button, Drawer, Input, Radio, Table, Tag } from 'antd';
import { catalogItemPrompt, itemPromptDraft, changeItemPromptMode, itemPromptMaxLength } from '../services/checklistPrompts';

const names = { 'clef-local': 'Clef', 'gemma-local': 'Gemma' };
const labels = { inherit: 'Ambos modelos', shared: 'Ambos modelos', 'per-model': 'Prompts separados' };
const usesModel = item => ['IA', 'IA + código'].includes(item.method);
const evaluationMethod = item => item.id === 'asistente_no_respondio_ultimo_mensaje' ? 'IA + reglas de código' : item.method;

export function resolvedItemPrompts(prompts, model) {
  return Object.fromEntries(Object.entries(prompts.byItem || {}).filter(([, p]) => p.mode !== 'inherit' && p.application !== 'replace')
    .map(([id, p]) => [id, p.mode === 'shared' ? p.shared : p.byModel[model]]));
}
export function resolvedItemCriteria(prompts, model) {
  return Object.fromEntries(Object.entries(prompts.byItem || {}).filter(([, p]) => p.mode !== 'inherit' && p.application === 'replace')
    .map(([id, p]) => [id, p.mode === 'shared' ? p.shared : p.byModel[model]]));
}

export default function ChecklistPrompts({ checklist = [], prompts, disabled, onChange }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const item = checklist.find(row => row.id === selected);
  const value = itemPromptDraft(item, prompts.byItem?.[selected]);
  const update = patch => onChange({ ...(prompts.byItem || {}), [selected]: { ...value, ...patch } });
  return <>
    <h2>Prompts por ítem del checklist</h2>
    <p>Consulta y edita el criterio que utilizará la IA para cada flag. Puedes usar el mismo prompt para Clef y Gemma o uno distinto para cada modelo. Los cambios se aplican a evaluaciones nuevas, en todos los países.</p>
    <p>Los ítems de código o cálculo no pasan por el modelo y no utilizan prompts. Sus fórmulas y parámetros requieren un cambio aparte.</p>
    <Input.Search aria-label="Buscar ítem del checklist" placeholder="Buscar ítem del checklist" value={search} onChange={e => setSearch(e.target.value)} allowClear className="automation-country-search" />
    <Table rowKey="id" dataSource={checklist.filter(row => `${row.id} ${row.name}`.toLowerCase().includes(search.toLowerCase()))} scroll={{ x: 850 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: 'No hay ítems que coincidan con la búsqueda.' }} columns={[
      { title: 'Ítem', render: (_, row) => <><strong>{row.name}</strong><div className="muted">{row.id}</div></> },
      { title: 'Método', render: (_, row) => evaluationMethod(row) },
      { title: 'Estado', render: (_, row) => <Tag>{row.active ? 'Activo' : 'Inactivo'}</Tag> },
      { title: 'Prompt', render: (_, row) => usesModel(row) ? labels[prompts.byItem?.[row.id]?.mode || 'inherit'] : 'No utiliza prompt' },
      { title: 'Acción', render: (_, row) => usesModel(row)
        ? <Button aria-label={`Editar prompt de ${row.name}`} disabled={disabled} onClick={() => setSelected(row.id)}>Editar prompt</Button>
        : <span className="muted">Fórmula o regla de código</span> },
    ]} />
    <Drawer title={item ? `Prompt: ${item.name}` : 'Prompt del ítem'} open={!!item} onClose={() => setSelected(null)} width="min(800px, 100vw)" extra={<Button onClick={() => setSelected(null)}>Volver a configuración</Button>}>
      {item && <div className="item-prompt-editor">
        <p className="muted">{item.name} · Versión {item.version}</p>
        <Radio.Group className="item-prompt-options" name="item-prompt-audience" role="radiogroup" aria-label="Aplicar el prompt" value={value.mode === 'per-model' ? 'per-model' : 'shared'} disabled={disabled} onChange={e => update(changeItemPromptMode(item, value, e.target.value))}>
          <Radio value="shared">Prompt para ambos modelos</Radio>
          <Radio value="per-model">Prompts separados</Radio>
        </Radio.Group>
        <p>Este texto es el criterio que utilizará el modelo para este flag. Al guardar, sustituye su definición y condición base en las evaluaciones nuevas. Se mantienen las instrucciones generales, el formato de respuesta y las reglas de evidencia.</p>
        {item.id === 'asistente_no_respondio_ultimo_mensaje'
          ? <p className="muted">Reglas automáticas de este flag: si la conversación sigue abierta y termina con un mensaje del cliente, queda sin evaluar; si el último mensaje no es del cliente, el resultado es 0. Estas reglas siguen aplicándose al editar el prompt.</p>
          : item.method === 'IA + código' && <p className="muted">Editar este prompt solo cambia la interpretación de la IA. La fórmula o integración de código requiere un cambio aparte.</p>}
        {value.mode !== 'per-model'
          ? <label className="automation-field"><span>Prompt para Clef y Gemma</span><Input.TextArea aria-label="Prompt para Clef y Gemma" value={value.mode === 'inherit' ? catalogItemPrompt(item) : value.shared} rows={12} maxLength={itemPromptMaxLength} showCount disabled={disabled} onChange={e => update({ mode: 'shared', shared: e.target.value })} /></label>
          : Object.entries(names).map(([id, name]) => <label className="automation-field" key={id}><span>Prompt para {name}</span><Input.TextArea aria-label={`Prompt para ${name}`} value={value.byModel[id]} rows={8} maxLength={itemPromptMaxLength} showCount disabled={disabled} onChange={e => update({ byModel: { ...value.byModel, [id]: e.target.value } })} /></label>)}
        <div><Button disabled={disabled} onClick={() => update(itemPromptDraft(item))}>Restaurar texto del catálogo</Button></div>
        <p className="muted">Los cambios quedan en el borrador. Pulsa «Guardar configuración» para crear una versión nueva. Los lotes iniciados mantienen sus prompts originales.</p>
      </div>}
    </Drawer>
  </>;
}
