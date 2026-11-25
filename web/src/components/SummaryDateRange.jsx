import { useEffect, useState } from 'react';
import { Button, Input } from 'antd';
import { MAX_SUMMARY_DAYS, summaryRangeError } from '../services/summaryDates';

export default function SummaryDateRange({ from, to, onApply }) {
  const [draft, setDraft] = useState({ from, to });
  useEffect(() => { setDraft({ from, to }); }, [from, to]);
  const error = summaryRangeError(draft.from, draft.to);
  const edited = draft.from !== from || draft.to !== to;
  return <form className="summary-custom-range" aria-label="Período personalizado" onSubmit={event => {
    event.preventDefault(); if (!error) onApply(draft.from, draft.to);
  }}>
    <label>Desde<Input type="date" aria-label="Resumen desde" value={draft.from} status={edited && error ? 'error' : undefined}
      onChange={event => setDraft(previous => ({ ...previous, from: event.target.value }))} /></label>
    <label>Hasta<Input type="date" aria-label="Resumen hasta" value={draft.to} status={edited && error ? 'error' : undefined}
      onChange={event => setDraft(previous => ({ ...previous, to: event.target.value }))} /></label>
    <Button htmlType="submit" size="small" disabled={!!error}>Aplicar fechas</Button>
    <span className="summary-custom-range-note" role={edited && error ? 'alert' : undefined}>{edited && error ? error : `Hasta ${MAX_SUMMARY_DAYS} días consecutivos · hora de Honduras`}</span>
  </form>;
}
