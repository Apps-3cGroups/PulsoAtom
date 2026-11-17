const countryNames = Object.freeze({ MX: 'México', PA: 'Panamá' });

// Correct portal labels without changing imported data or country identifiers.
export function countryLabel(code, fallback) {
  return Object.hasOwn(countryNames, code) ? countryNames[code] : fallback || code;
}

const searchText = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');
export function countryMatchesSearch(input, option) {
  const query = searchText(input).trim();
  return searchText(option?.label).includes(query) || searchText(option?.value).includes(query);
}

// Only these built-in catalog descriptions are corrected for display. Never
// apply this to transcripts, evidence, model answers or editable form values.
const catalogLabels = new Map([
  ['1 si aplicaba mencionar otro punto del guión de venta y el asistente no lo mencionó.',
    '1 si aplicaba mencionar otro punto del guion de venta y el asistente no lo mencionó.'],
  ['Requiere la definición de cuándo aplica el punto del guión de venta.',
    'Requiere la definición de cuándo aplica el punto del guion de venta.'],
]);

export function catalogText(value) {
  return catalogLabels.get(value) ?? value;
}
