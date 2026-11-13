import { countryLabel, countryMatchesSearch } from '../services/presentationText';
import { Select } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { Mark } from './common';
import './ExceptionControls.css';

const labels = { critical: 'Crítico', normal: 'Menor', positive: 'Positivo', refuted: 'Refutado', human: 'Humano' };

export function ExceptionsFilter({ kinds, selected, onToggle }) {
  return <><span className="control-label">Excepciones</span>{kinds.map(kind => <button
    type="button" key={kind} className={`legend-toggle exception-toggle ${selected.includes(kind) ? 'selected' : ''}`}
    aria-label={labels[kind]} aria-pressed={selected.includes(kind)} onClick={() => onToggle(kind)}
  ><Mark kind={kind} />{labels[kind]}</button>)}</>;
}

export function CountrySelect({ countries, value, onChange, label }) {
  return <Select mode="multiple" maxTagCount="responsive" allowClear showSearch optionFilterProp="label" filterOption={countryMatchesSearch}
    aria-label={label} placeholder="Países" suffixIcon={<DownOutlined className="country-select-chevron" />}
    value={value} onChange={onChange} options={countries.map(c => ({ label: countryLabel(c.code, c.name), value: c.code }))}
    className="country-multiselect country-dropdown" styles={{ popup: { root: { zIndex: 1100 } } }} />;
}
