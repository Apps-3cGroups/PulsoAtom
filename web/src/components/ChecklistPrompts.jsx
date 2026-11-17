import { useState } from 'react';
import { Alert, Button, Drawer, Input, Table, Tag } from 'antd';
import Select from './Select';
import { catalogItemPrompt, itemPromptDraft, changeItemPromptMode, itemPromptMaxLength } from '../services/checklistPrompts';

const names = { 'clef-local': 'Clef', 'gemma-local': 'Gemma' };
const labels = { inherit: 'Del catálogo', shared: 'Compartido', 'per-model': 'Por modelo' };

export function resolvedItemPrompts(prompts, model) {
  return Object.fromEntries(Object.entries(prompts.byItem || {}).filter(([, p]) => p.mode !== 'inherit')
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
    <p>Cada ítem trae su definición y condición del catálogo como punto de partida. Puedes personalizar el prompt para ambos modelos o para cada uno. Las instrucciones se aplican solo a ese ítem, en todos los países; los criterios y el formato técnico se conservan.</p>
    <Input.Search aria-label="Buscar ítem del checklist" placeholder="Buscar ítem del checklist" value={search} onChange={e => setSearch(e.target.value)} allowClear className="automation-country-search" />
    <Table rowKey="id" dataSource={checklist.filter(row => `${row.id} ${row.name}`.toLowerCase().includes(search.toLowerCase()))} scroll={{ x: 650 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: 'No hay ítems que coincidan con la búsqueda.' }} columns={[
      { title: 'Ítem', render: (_, row) => <><strong>{row.name}</strong><div className="muted">{row.id}</div></> },
      { title: 'Estado', render: (_, row) => <Tag>{row.active ? 'Activo' : 'Inactivo'}</Tag> },
      { title: 'Prompt', render: (_, row) => ['IA', 'IA + código'].includes(row.method) ? labels[prompts.byItem?.[row.id]?.mode || 'inherit'] : 'Calculado por código' },
      { title: 'Acción', render: (_, row) => <Button aria-label={`Editar prompt de ${row.name}`} disabled={disabled || !['IA', 'IA + código'].includes(row.method)} onClick={() => setSelected(row.id)}>Editar prompt</Button> },
    ]} />
    <Drawer title={item ? `Prompt: ${item.name}` : 'Prompt del ítem'} open={!!item} onClose={() => setSelected(null)} width="min(800px, 100vw)" extra={<Button onClick={() => setSelected(null)}>Volver a configuración</Button>}>
      {item && <>
        <p><strong>{item.id}</strong> · Versión del ítem {item.version}</p>
        <label className="automation-field"><span>Modo del prompt del ítem</span><Select aria-label="Modo del prompt del ítem" value={value.mode} disabled={disabled} onChange={mode => update(changeItemPromptMode(item, value, mode))} options={Object.entries(labels).map(([key, label]) => ({ value: key, label }))} /></label>
        {value.mode === 'inherit' && <Alert type="info" showIcon message="Prompt prellenado con los criterios del catálogo" description="Se aplica junto con las instrucciones generales. Al editarlo, pasará a ser un prompt compartido por Clef y Gemma. Los cambios se guardan al pulsar «Guardar configuración»." />}
        {value.mode !== 'per-model'
          ? <label className="automation-field"><span>{value.mode === 'inherit' ? 'Prompt base del ítem' : 'Prompt compartido del ítem'}</span><Input.TextArea aria-label={value.mode === 'inherit' ? 'Prompt base del ítem' : 'Prompt compartido del ítem'} value={value.mode === 'inherit' ? catalogItemPrompt(item) : value.shared} rows={10} maxLength={itemPromptMaxLength} showCount disabled={disabled} onChange={e => update({ mode: 'shared', shared: e.target.value })} /></label>
          : Object.entries(names).map(([id, name]) => <label className="automation-field" key={id}><span>Prompt del ítem para {name}</span><Input.TextArea aria-label={`Prompt del ítem para ${name}`} value={value.byModel[id]} rows={8} maxLength={itemPromptMaxLength} showCount disabled={disabled} onChange={e => update({ byModel: { ...value.byModel, [id]: e.target.value } })} /></label>)}
        <p className="muted">Los cambios quedan en el borrador. Pulsa «Guardar configuración» para crear una versión nueva. Los lotes iniciados mantienen sus prompts originales.</p>
      </>}
    </Drawer>
  </>;
}
