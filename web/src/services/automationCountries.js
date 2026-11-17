export function automationCountryRows(countries, operatingCountries, search = '') {
  const codes = new Set(operatingCountries.map(country => country.code));
  const query = search.trim().toLocaleLowerCase('es');
  return countries.map((country, index) => ({ ...country, index }))
    .filter(country => codes.has(country.code)
      && `${country.name} ${country.code}`.toLocaleLowerCase('es').includes(query));
}
