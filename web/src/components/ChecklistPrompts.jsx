import { useState } from 'react';
import { Alert, Button, Drawer, Input, Select, Table, Tag } from 'antd';

const names = { 'clef-local': 'Clef', 'gemma-local': 'Gemma' };
const empty = () => ({ mode: 'inherit', shared: '', byModel: { 'clef-local': '', 'gemma-local': '' } });
const labels = { inherit: 'Instrucciones generales', shared: 'Compartido', 'per-model': 'Por modelo' };

export function resolvedItemPrompts(prompts, model) {
  return Object.fromEntries(Object.entries(prompts.byItem || {}).filter(([, p]) => p.mode !== 'inherit')
    .map(([id, p]) => [id, p.mode === 'shared' ? p.shared : p.byModel[model]]));
}

export default function ChecklistPrompts({ checklist = [], prompts, disabled, onChange }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const item = checklist.find(row => row.id === selected);
  const value = prompts.byItem?.[selected] || empty();
  const update = patch => onChange({ ...(prompts.byItem || {}), [selected]: { ...value, ...patch } });
  return <>
    <h2>Prompts por ítem del checklist</h2>
    <p>Cada instrucción se añade únicamente al ítem elegido, en todos los países. Puedes compartirla entre Clef y Gemma o escribir una para cada modelo. Los criterios y el formato técnico del checklist se conservan.</p>
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
        <p>{item.definition}</p>{item.condition && <p><strong>Criterio:</strong> {item.condition}</p>}
        <label className="automation-field"><span>Modo del prompt del ítem</span><Select aria-label="Modo del prompt del ítem" value={value.mode} disabled={disabled} onChange={mode => update({ mode })} options={Object.entries(labels).map(([key, label]) => ({ value: key, label }))} /></label>
        {value.mode === 'inherit' ? <Alert type="info" showIcon message="Se usan las instrucciones generales y los criterios del checklist." /> : value.mode === 'shared'
          ? <label className="automation-field"><span>Prompt compartido del ítem</span><Input.TextArea aria-label="Prompt compartido del ítem" value={value.shared} rows={10} maxLength={6000} showCount disabled={disabled} onChange={e => update({ shared: e.target.value })} /></label>
          : Object.entries(names).map(([id, name]) => <label className="automation-field" key={id}><span>Prompt del ítem para {name}</span><Input.TextArea aria-label={`Prompt del ítem para ${name}`} value={value.byModel[id]} rows={8} maxLength={6000} showCount disabled={disabled} onChange={e => update({ byModel: { ...value.byModel, [id]: e.target.value } })} /></label>)}
        <p className="muted">Los cambios quedan en el borrador. Pulsa «Guardar configuración» para crear una versión nueva. Los lotes iniciados mantienen sus prompts originales.</p>
      </>}
    </Drawer>
  </>;
}
