"""Importa definiciones del Excel v5; no modifica el libro ni conecta a bases de datos."""
import argparse
import json
import re
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--workbook', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1] / 'src' / 'data'
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(args.workbook) as archive:
    strings = []
    if 'xl/sharedStrings.xml' in archive.namelist():
        strings = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('s:si', ns)]
    relations = {node.attrib['Id']: node.attrib['Target'] for node in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
    sheets = ET.fromstring(archive.read('xl/workbook.xml')).findall('s:sheets/s:sheet', ns)
    def read_sheet(name):
        sheet = next(node for node in sheets if node.attrib['name'] == name)
        target = relations[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
        target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
        output = []
        for row in ET.fromstring(archive.read(target)).findall('s:sheetData/s:row', ns):
            values = {}
            for cell in row.findall('s:c', ns):
                node = cell.find('s:v', ns)
                value = node.text if node is not None else ''
                if cell.attrib.get('t') == 's':
                    value = strings[int(value)] if value else ''
                elif cell.attrib.get('t') == 'inlineStr':
                    value = ''.join(cell.find('s:is', ns).itertext())
                values[re.sub(r'\d', '', cell.attrib['r'])] = value
            output.append(values)
        return output

    legacy_path = root / 'catalog-legacy.json'
    if not legacy_path.exists():
        original = json.loads((root / 'catalog.json').read_text())
        assert len(original) == 130, 'Conservar el catálogo original antes de importar v5.'
        legacy_path.write_text(json.dumps(original, ensure_ascii=False, indent=2) + '\n')
    labels = {v['id']: v['name'] for v in json.loads(legacy_path.read_text())}
    labels.update(json.loads((root / 'catalog-v5-labels.json').read_text()))
    context_flags = {'faltante_no_manejado', 'faltante_agotado', 'cliente_abusivo', 'cliente_pregunta_irrelevante',
                     'cliente_pregunta_inapropiada', 'cliente_envio_imagen', 'cliente_envio_audio', 'cliente_hizo_llamada',
                     'cliente_envio_url', 'asistente_ofrecio_sustituto', 'sustituto_aplicable',
                     'asistente_ofrecio_sustituto_marca_propia', 'sustituto_marca_propia_aplicable',
                     'asistente_ofrecio_cross_sell', 'cliente_pidio_producto_receta', 'cliente_pidio_producto_controlado'}
    pending = {
        'varios_humanos_atendieron': 'Falta la identidad del asesor en cada mensaje de Atom.',
        'botones_no_usados': 'Faltan los botones ofrecidos y seleccionados en los eventos de Atom.',
        'primera_respuesta_humano_mayor_5_min': 'Pendiente de configurar el horario de atención por país.',
    }
    items = []
    for row in read_sheet('Catálogo')[1:]:
        if not row.get('C'): continue
        variable, kind, mark, phase = row['C'], row['D'], row.get('E', ''), int(row['H'])
        assert variable in labels, f'Falta etiqueta legible: {variable}'
        polarity = 'positivo' if mark == '+' else 'contexto' if kind in ('Métrica', 'Descriptor') or variable in context_flags else 'negativo'
        items.append(dict(id=variable, order=int(row['A']), family=row['B'], variable=variable, name=labels[variable],
                          type=kind, mark=mark, definition=row['F'], method=row['G'], phase=phase,
                          condition=row.get('I', ''), polarity=polarity, active=phase == 1, template=False,
                          version=1, catalogRevision='v5-2026-11-03', retired=False,
                          availability=pending.get(variable) or (row.get('I') or 'Pendiente de fase e integración.' if phase > 1 else None)))
    assert len(items) == len({v['id'] for v in items}) == 93
    assert sum(v['active'] for v in items) == 64
    assert sum(v['mark'] == 'Crítico' for v in items) == 30
    assert sum(v['mark'] == '+' for v in items) == 6
    (root / 'catalog.json').write_text(json.dumps(items, ensure_ascii=False, indent=2) + '\n')
    notes = [{'topic': row.get('A', ''), 'text': row.get('B', '')} for row in read_sheet('Notas') if row.get('B')]
    (root / 'catalog-v5-notes.json').write_text(json.dumps(notes, ensure_ascii=False, indent=2) + '\n')
    print('Catálogo v5 importado: 93 variables, 64 habilitadas; Excel intacto.')
