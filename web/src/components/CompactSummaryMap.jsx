import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Drawer, Tooltip } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import { Mark, dateText, timeText } from './common';
import { compactDaySlots, groupCompactDay, compactMarks } from '../services/summaryMap';
import { classificationOf, dualMarks, evaluationStatus, evaluationStatusLabel } from '../services/flags';
import { useAppearance } from '../appearance';
import './CompactSummaryMap.css';

const labels = { critical: 'Crítico', normal: 'Menor', refuted: 'Refutado', human: 'Humano', positive: 'Positivo' };

export default function CompactSummaryMap({ groups, days, visible, variable, classification, onOpen, onHistory }) {
  const { fontScale } = useAppearance();
  const map = useRef(null), timeline = useRef(null);
  const [layout, setLayout] = useState({ slots: 1, rowHeight: 20 });
  const [selection, setSelection] = useState(null);
  const rowCount = groups.reduce((sum, group) => sum + group.agents.length, 0);
  const filters = { visible, variable, classification };
  useLayoutEffect(() => {
    const measure = () => {
      if (!map.current || !timeline.current) return;
      const headerHeight = map.current.querySelector('.compact-map-head')?.getBoundingClientRect().height || 0;
      const countryHeight = [...map.current.querySelectorAll('.compact-country-title')].reduce((sum, title) => sum + title.getBoundingClientRect().height, 0);
      const available = map.current.clientHeight - headerHeight - countryHeight - 2;
      const next = { slots: compactDaySlots(timeline.current.clientWidth, days.length), rowHeight: Math.max(fontScale > 1 ? 22 * fontScale : 2, Math.min(22, available / Math.max(1, rowCount))) };
      setLayout(current => current.slots === next.slots && current.rowHeight === next.rowHeight ? current : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(map.current); observer.observe(timeline.current); measure();
    return () => observer.disconnect();
  }, [days.length, groups.length, rowCount, fontScale]);
  useEffect(() => { setSelection(null); }, [groups, days, visible, variable, classification]);
  const openGroup = (conversations, agent, day) => conversations.length === 1 ? onOpen(conversations[0]) : setSelection({ conversations, agent, day });
  return <>
    <div ref={map} className="compact-summary-map" style={{ '--compact-days': days.length, '--compact-slots': layout.slots, '--compact-row': `${layout.rowHeight}px` }}>
      <div className="compact-map-head"><span>PAÍS · ASISTENTE DE VENTA</span><div ref={timeline} className="compact-day-heads">{days.map((day, index) => <span key={day} className={index % 7 === 0 ? 'week-start' : ''}><span title={dateText(day)}>{index === 0 ? 'Ahora · hoy' : index % 7 === 0 ? dateText(day, { year: undefined, weekday: 'short' }) : ''}</span></span>)}</div></div>
      {groups.map(group => <section className="compact-country" key={group.code} aria-label={group.name}>
        <div className="compact-country-title"><button onClick={() => onHistory(group.code)}>{group.name}<span className="country-code">{group.code}</span><RightOutlined /></button><span /></div>
        {group.agents.map(agent => <div className="compact-agent-row" key={agent.id}><div className="compact-agent-name" title={agent.name}><i /><span>{agent.name}</span></div><div className="compact-agent-days">{days.map((day, index) => <div className={`compact-day ${index % 7 === 0 ? 'week-start' : ''}`} key={day}>{groupCompactDay(agent.byDay[day], layout.slots).map(conversations => {
          const { kinds, names } = compactMarks(conversations, filters);
          const pending = conversations.some(c => evaluationStatus(c) !== 'evaluated');
          const agreed = conversations.some(c => dualMarks(c, variable).some(m => classification === 'all' || classificationOf(m) === classification));
          const grouped = conversations.length > 1;
          const title = grouped ? `${conversations.length} conversaciones · ${agent.name}` : conversations[0].client.name;
          return <Tooltip key={conversations[0].id} mouseEnterDelay={.2} title={<div className="conversation-tooltip"><b>{title}</b><span>{dateText(day)}{grouped ? ' · Abrir grupo para ver cada conversación' : ` · ${timeText(conversations[0].displayAt)}`}</span><span>{names.length ? names.join(' · ') : 'Sin flags visibles'}</span>{pending && <span>Contiene evaluaciones pendientes o parciales</span>}{agreed && <span>Hay flags detectados por ambos modelos</span>}</div>}><button className={`compact-conversation tone-${kinds[0] || 'neutral'} ${pending ? 'is-pending' : ''} ${kinds.length ? 'with-flags' : ''} ${grouped ? 'is-group' : ''} ${agreed ? 'is-dual' : ''}`} aria-label={`${grouped ? 'Abrir grupo de ' : 'Abrir '}${title}, ${day}${kinds.length ? `, ${kinds.map(k => labels[k]).join(', ')}` : ', sin flags visibles'}`} onClick={() => openGroup(conversations, agent, day)}>{kinds.map(kind => <span className={`compact-symbol compact-symbol-${kind}`} key={kind}><Mark kind={kind} small /><i /></span>)}</button></Tooltip>;
        })}</div>)}</div></div>)}
      </section>)}
    </div>
    <Drawer className="compact-group-drawer" open={!!selection} onClose={() => setSelection(null)} width={480} title={selection ? `${selection.agent.name} · ${dateText(selection.day, { year: undefined })}` : ''}>
      {selection && <><p className="compact-group-note">{selection.conversations.length} conversaciones agrupadas en esta celda. Selecciona una para consultar todos sus mensajes y resultados.</p><div className="compact-group-list">{selection.conversations.map(c => {
        const { kinds, names } = compactMarks([c], filters);
        return <button key={c.id} onClick={() => onOpen(c)}><div><strong>{c.client.name}{c.client.phoneLast4 ? ` · …${c.client.phoneLast4}` : ''}</strong><span>{timeText(c.displayAt)} <RightOutlined /></span></div><small>{evaluationStatusLabel(c)}</small><p><span>{kinds.map(kind => <Mark kind={kind} key={kind} small />)}</span>{names.length ? names.join(' · ') : 'Sin flags visibles'}</p></button>;
      })}</div></>}
    </Drawer>
  </>;
}
