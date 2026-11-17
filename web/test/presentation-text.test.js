import test from 'node:test';
import assert from 'node:assert/strict';
import { countryLabel, countryMatchesSearch, catalogText } from '../src/services/presentationText.js';

test('country labels include the accents for canonical Mexico and Panama codes', () => {
  assert.equal(countryLabel('MX', 'Mexico'), 'México');
  assert.equal(countryLabel('PA', 'Panama'), 'Panamá');
  assert.equal(countryLabel('MX'), 'México');
  assert.equal(countryLabel('PA'), 'Panamá');
});

test('other labels and country codes are preserved without inventing aliases', () => {
  assert.equal(countryLabel('HN', 'Honduras'), 'Honduras');
  assert.equal(countryLabel('XX', 'País de prueba'), 'País de prueba');
  assert.equal(countryLabel('PN', 'Nombre importado'), 'Nombre importado');
  assert.equal(countryLabel('PN'), 'PN');
  assert.equal(countryLabel('XX'), 'XX');
  assert.equal(countryLabel('toString', 'País importado'), 'País importado');
});

test('rendering an accented country label leaves the source object unchanged', () => {
  const country = Object.freeze({ code: 'PA', name: 'Panama' });
  assert.equal(countryLabel(country.code, country.name), 'Panamá');
  assert.deepEqual(country, { code: 'PA', name: 'Panama' });
});

test('accented country labels remain searchable with or without accents and by code', () => {
  const mexico = Object.freeze({ label: 'México', value: 'MX' });
  const panama = Object.freeze({ label: 'Panamá', value: 'PA' });
  for (const query of ['Mexico', 'México', 'MÉXICO', 'mx', '  MEXICO  ']) assert.equal(countryMatchesSearch(query, mexico), true);
  for (const query of ['Panama', 'Panamá', 'PANAMA', 'pa']) assert.equal(countryMatchesSearch(query, panama), true);
  assert.equal(countryMatchesSearch('Honduras', mexico), false);
  assert.equal(countryMatchesSearch('México', panama), false);
  assert.equal(countryMatchesSearch('', mexico), true);
});

test('only the two known catalog descriptions receive the guion correction', () => {
  const definition = '1 si aplicaba mencionar otro punto del guión de venta y el asistente no lo mencionó.';
  const condition = 'Requiere la definición de cuándo aplica el punto del guión de venta.';
  const snapshot = Object.freeze({ definition, condition });
  assert.equal(catalogText(snapshot.definition), definition.replace('guión', 'guion'));
  assert.equal(catalogText(snapshot.condition), condition.replace('guión', 'guion'));
  assert.deepEqual(snapshot, { definition, condition });
  assert.equal(catalogText('El cliente escribió guión.'), 'El cliente escribió guión.');
  assert.equal(catalogText('Texto de una definición personalizada.'), 'Texto de una definición personalizada.');
  assert.equal(catalogText(null), null);
  assert.equal(catalogText(undefined), undefined);
});
