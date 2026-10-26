"""Extrae el catálogo sin modificar el Excel ni ejecutar el HTML de referencia."""
import argparse
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--workbook', required=True)
parser.add_argument('--prototype', required=True)
args = parser.parse_args()
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
html = Path(args.prototype).read_text()
raw_line = next(line for line in html.splitlines() if line.startswith('const CATALOGO_RAW'))
raw = json.loads(raw_line.split('=', 1)[1].strip().rstrip(';'))
by_variable = {row[0]: row for row in raw}
label_block = html.split('const LABEL = {', 1)[1].split('};', 1)[0]
labels = dict(re.findall(r'(\w+)\s*:\s*"([^"]*)"', label_block))
labels.update(json.loads((Path(__file__).resolve().parents[1] / 'src/data/catalog-labels.json').read_text()))
with zipfile.ZipFile(args.workbook) as archive:
    strings = []
    if 'xl/sharedStrings.xml' in archive.namelist():
        strings = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('s:si', ns)]
    relations = {node.attrib['Id']: node.attrib['Target'] for node in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
    sheets = ET.fromstring(archive.read('xl/workbook.xml')).findall('s:sheets/s:sheet', ns)
    sheet = next(node for node in sheets if node.attrib['name'] == 'Catálogo')
    target = relations[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
    target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
    items = []
    for row in ET.fromstring(archive.read(target)).findall('s:sheetData/s:row', ns)[1:]:
        values = {}
        for cell in row.findall('s:c', ns):
            node = cell.find('s:v', ns)
            value = node.text if node is not None else ''
            if cell.attrib.get('t') == 's':
                value = strings[int(value)] if value else ''
            elif cell.attrib.get('t') == 'inlineStr':
                value = ''.join(cell.find('s:is', ns).itertext())
            values[re.sub(r'\d', '', cell.attrib['r'])] = value
        if not values.get('C'):
            continue
        variable = values['C']
        original = by_variable[variable]
        assert original[1] == values['B'] and original[2] == values['D'] and original[7] == values['F']
        phase = int(values['H'])
        mark = values.get('E', '')
        items.append({
            'id': variable, 'order': int(values['A']), 'family': values['B'],
            'variable': variable, 'name': labels.get(variable, variable.replace('_', ' ').capitalize()),
            'type': values['D'], 'mark': mark, 'definition': values['F'],
            'method': values['G'], 'phase': phase, 'condition': values.get('I', ''),
            'polarity': original[4], 'active': phase == 1 and mark in ('P1', 'P2'),
            'template': '[punto]' in variable, 'version': 1,
        })
assert len(items) == 130
assert len({item['id'] for item in items}) == 130
assert len({item['family'] for item in items}) == 17
assert sum(item['active'] for item in items) == 12
output = Path(__file__).resolve().parents[1] / 'src/data/catalog.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(items, ensure_ascii=False, indent=2) + '\n')
print(f'Catálogo generado: {len(items)} variables, 17 familias y 12 activas.')
