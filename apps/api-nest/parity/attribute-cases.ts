/**
 * Parity cases for the attribute admin (phase 4 part 2): attributes, their
 * values -- `move` among them -- and size charts. Every write is compared by
 * the rows it leaves (attributes, values, charts and their rows, category
 * links, image colours), the audit entries, and the jobs it queues.
 *
 * Rows come from the demo seed, fixture_staff.py and fixture_attributes.py.
 */
import pg from 'pg';

import { staffHeaders, type Who } from './catalog-admin-cases.ts';
import { restoreTables } from './restore.ts';
import type { Case } from './run.ts';

const TABLES = [
  'catalog_attribute',
  'catalog_attributevalue',
  'catalog_categoryattribute',
  'catalog_productimage',
  'catalog_sizechart',
  'catalog_sizechartrow',
];

const EFFECTS = [
  `SELECT name, code, kind, is_variant_defining, is_filterable, position,
          updated_at >= $1 AS touched, created_at >= $1 AS created
     FROM catalog_attribute ORDER BY code`,
  `SELECT a.code, v.value, v.label, v.swatch, v.position, v.updated_at >= $1 AS touched
     FROM catalog_attributevalue v JOIN catalog_attribute a ON a.id = v.attribute_id
    ORDER BY a.code, v.value`,
  `SELECT (SELECT count(*) FROM catalog_categoryattribute)::int AS links,
          (SELECT count(*) FROM catalog_productimage WHERE attribute_value_id IS NULL)::int AS shared_images,
          (SELECT count(*) FROM catalog_productimage WHERE updated_at >= $1)::int AS images_touched`,
  `SELECT a.code, c.name, c.system, c.columns::text AS columns, c.notes, c.position,
          u.email AS created_by, c.updated_at >= $1 AS touched, c.created_at >= $1 AS created
     FROM catalog_sizechart c JOIN catalog_attribute a ON a.id = c.attribute_id
     LEFT JOIN accounts_user u ON u.id = c.created_by_id ORDER BY a.code, c.name`,
  `SELECT c.name AS chart, v.value, r.cells::text AS cells, r.created_at >= $1 AS fresh
     FROM catalog_sizechartrow r JOIN catalog_sizechart c ON c.id = r.chart_id
     JOIN catalog_attributevalue v ON v.id = r.attribute_value_id ORDER BY c.name, v.value`,
  `SELECT action, entity_type, entity_label, actor_label, old_values::text AS old_values,
          new_values::text AS new_values, reason, request_id <> '' AS has_request
     FROM core_auditlog WHERE created_at >= $1 ORDER BY created_at, action`,
];

export async function attributeCases(): Promise<Case[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const auth = await staffHeaders(db);
  const attributeRows = await db.query<{ code: string; id: string }>(
    `SELECT code, id FROM catalog_attribute ORDER BY code`,
  );
  const valueRows = await db.query<{ code: string; value: string; id: string }>(
    `SELECT a.code, v.value, v.id FROM catalog_attributevalue v
       JOIN catalog_attribute a ON a.id = v.attribute_id ORDER BY a.code, v.value`,
  );
  const chartRows = await db.query<{ name: string; id: string }>(
    `SELECT name, id FROM catalog_sizechart ORDER BY name`,
  );
  await db.end();
  const attribute = new Map(attributeRows.rows.map((row) => [row.code, row.id]));
  if (!attribute.has('parity-order')) {
    console.log('SKIP  attribute admin: fixture_attributes.py has not been applied');
    return [];
  }
  const value = new Map(valueRows.rows.map((row) => [`${row.code}:${row.value}`, row.id]));
  const chart = new Map(chartRows.rows.map((row) => [row.name, row.id]));
  const known = new Set([...attribute.values(), ...value.values(), ...chart.values()]);
  const A = (code: string) => attribute.get(code) as string;
  const V = (key: string) => value.get(key) as string;
  const C = (name: string) => chart.get(name) as string;
  const missing = '00000000-0000-4000-8000-000000000000';

  const cases: Case[] = [];
  const read = (name: string, path: string, who: Who = 'manager') =>
    cases.push({ name: `admin attributes: ${name}`, path, headers: auth(who) });
  const write = (name: string, method: string, path: string, body: unknown, who: Who = 'manager') =>
    cases.push({
      name: `admin attributes: ${name}`,
      method,
      path,
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      reset: (client) => restoreTables(client, TABLES),
      effects: EFFECTS,
      jobs: true,
      normalize: (response) => {
        const row = response as { id?: unknown } | null;
        if (row && typeof row === 'object' && typeof row.id === 'string' && !known.has(row.id))
          row.id = '<minted>';
      },
    });

  // --- Attributes -----------------------------------------------------------------
  for (const query of [
    '',
    '?ordering=values',
    '?ordering=-values',
    '?ordering=code',
    '?ordering=-position,name',
    '?ordering=kind,code',
    '?ordering=variant_usage',
    '?ordering=bogus',
  ]) {
    read(`attributes ${query || '(all)'}`, `/api/v1/attributes/${query}`);
  }
  for (const [code, id] of attribute) read(`attribute ${code}`, `/api/v1/attributes/${id}/`);
  read(
    'attribute: ordering through a relation, one row',
    `/api/v1/attributes/${A('size')}/?ordering=values`,
  );
  read('attribute: not a uuid', '/api/v1/attributes/abc/');
  read('attribute: missing', `/api/v1/attributes/${missing}/`);

  write('create attribute', 'POST', '/api/v1/attributes/', { name: 'Parity Weave', code: 'weave' });
  write('create attribute, every field', 'POST', '/api/v1/attributes/', {
    name: 'Parity Finish',
    code: 'finish',
    kind: 'COLOR',
    is_variant_defining: false,
    is_filterable: 'no',
    position: '9',
  });
  write('create attribute, taken name and code', 'POST', '/api/v1/attributes/', {
    name: 'Size',
    code: 'size',
  });
  write('create attribute, bad code and kind', 'POST', '/api/v1/attributes/', {
    name: 'X',
    code: 'not a slug',
    kind: 'BOGUS',
  });
  write('create attribute, kind not a string', 'POST', '/api/v1/attributes/', {
    name: 'X',
    code: 'x',
    kind: 1,
  });
  write('create attribute, no code', 'POST', '/api/v1/attributes/', { name: 'X' });
  write('create attribute, long name', 'POST', '/api/v1/attributes/', {
    name: 'n'.repeat(65),
    code: 'c'.repeat(65),
  });

  const size = `/api/v1/attributes/${A('size')}/`;
  write('Size stops being a Size', 'PATCH', size, { kind: 'TEXT' });
  write('Size stays a Size', 'PATCH', size, { kind: 'SIZE', position: 0 });
  write(
    'a chart-only Size attribute becomes text',
    'PATCH',
    `/api/v1/attributes/${A('parity-fit-size')}/`,
    {
      kind: 'NUMBER',
    },
  );
  write('colour stops defining variants', 'PATCH', `/api/v1/attributes/${A('color')}/`, {
    is_variant_defining: false,
  });
  write(
    'a stated specification starts defining variants',
    'PATCH',
    `/api/v1/attributes/${A('material')}/`,
    {
      is_variant_defining: true,
    },
  );
  write(
    'an unused attribute starts defining variants',
    'PATCH',
    `/api/v1/attributes/${A('parity-order')}/`,
    {
      is_variant_defining: true,
      is_filterable: true,
    },
  );
  write('attribute keeps its own name', 'PATCH', size, { name: 'Size', code: 'size' });
  write('attribute takes another name', 'PATCH', size, { name: 'Shoe size' });
  write('replace attribute', 'PUT', `/api/v1/attributes/${A('parity-order')}/`, {
    name: 'Parity Ordered',
    code: 'parity-ordered',
  });
  write('replace attribute, no code', 'PUT', size, { name: 'Size' });
  write('delete attribute with variants', 'DELETE', size, undefined, 'admin');
  write(
    'delete stated attribute',
    'DELETE',
    `/api/v1/attributes/${A('material')}/`,
    undefined,
    'admin',
  );
  write(
    'delete attribute with a chart',
    'DELETE',
    `/api/v1/attributes/${A('parity-fit-size')}/`,
    undefined,
    'admin',
  );
  write(
    'delete unused attribute',
    'DELETE',
    `/api/v1/attributes/${A('parity-order')}/`,
    undefined,
    'admin',
  );

  // --- Attribute values ---------------------------------------------------------------
  for (const query of [
    '',
    `?attribute=${A('size')}`,
    `?attribute=${A('parity-order')}&ordering=-value`,
    '?attribute=abc',
    `?attribute=${missing}`,
    '?ordering=attribute',
    '?ordering=-attribute,attribute__code',
    '?ordering=attribute_code',
    '?ordering=-position,value',
    '?ordering=label,value',
    '?ordering=display',
  ]) {
    read(`values ${query || '(all)'}`, `/api/v1/attribute-values/${query}`);
  }
  for (const [key, id] of value) read(`value ${key}`, `/api/v1/attribute-values/${id}/`);
  read('value: filtered out', `/api/v1/attribute-values/${V('size:XS')}/?attribute=${A('color')}`);

  const values = '/api/v1/attribute-values/';
  write('create value', 'POST', values, { attribute: A('parity-order'), value: 'e', position: 2 });
  write('create value, taken in its attribute', 'POST', values, {
    attribute: A('size'),
    value: 'XS',
  });
  write('create value, same text elsewhere', 'POST', values, {
    attribute: A('parity-order'),
    value: 'XS',
  });
  for (const swatch of ['navy', '#ABC', ' #AaBbCc ', '#12345', '', '#11223344', 'rgb(0,0,0)']) {
    write(`create value, swatch ${JSON.stringify(swatch)}`, 'POST', values, {
      attribute: A('parity-order'),
      value: 'swatched',
      swatch,
    });
  }
  write('create value, no attribute', 'POST', values, { value: 'x' });
  write('create value, bad attribute and blank value', 'POST', values, {
    attribute: 'abc',
    value: ' ',
  });
  write('create value, list body', 'POST', values, [1]);
  const xs = `/api/v1/attribute-values/${V('size:XS')}/`;
  write('edit value label', 'PATCH', xs, { label: 'Extra small' });
  write('edit value to a sibling', 'PATCH', xs, { value: 'S' });
  write('edit value, unchanged', 'PATCH', xs, { value: 'XS', attribute: A('size') });
  write(
    'edit value, to another attribute',
    'PATCH',
    `/api/v1/attribute-values/${V('parity-order:a')}/`,
    {
      attribute: A('size'),
    },
  );
  write(
    'edit value, onto a taken pair',
    'PATCH',
    `/api/v1/attribute-values/${V('parity-order:a')}/`,
    {
      attribute: A('size'),
      value: 'XS',
    },
  );
  write('replace value, no attribute', 'PUT', xs, { value: 'XS' });
  write('delete value with variants', 'DELETE', xs, undefined, 'admin');
  write(
    'delete stated value',
    'DELETE',
    `/api/v1/attribute-values/${V('material:Cotton')}/`,
    undefined,
    'admin',
  );
  write(
    'delete charted value',
    'DELETE',
    `/api/v1/attribute-values/${V('parity-fit-size:Tall')}/`,
    undefined,
    'admin',
  );
  write(
    'delete free value',
    'DELETE',
    `/api/v1/attribute-values/${V('parity-order:a')}/`,
    undefined,
    'admin',
  );
  write(
    'delete value under a photograph',
    'DELETE',
    `/api/v1/attribute-values/${V('color:Parity Teal')}/`,
    undefined,
    'admin',
  );

  // `move`: no requirement declared for it, so only an owner passes (D117).
  const move = (key: string) => `/api/v1/attribute-values/${V(key)}/move/`;
  write('move as a manager', 'POST', move('size:S'), { direction: 'up' });
  write('move as an administrator', 'POST', move('size:S'), { direction: 'up' }, 'admin');
  write('move up', 'POST', move('size:M'), { direction: 'UP' }, 'owner');
  write('move down', 'POST', move('size:M'), { direction: 'down' }, 'owner');
  write('move the first up', 'POST', move('size:XS'), { direction: 'up' }, 'owner');
  write(
    'move along a run that shares a position',
    'POST',
    move('parity-order:b'),
    { direction: 'down' },
    'owner',
  );
  write(
    'move up a run that shares a position',
    'POST',
    move('parity-order:c'),
    { direction: 'up' },
    'owner',
  );
  write('move sideways', 'POST', move('size:M'), { direction: 'sideways' }, 'owner');
  write('move with no direction', 'POST', move('size:M'), {}, 'owner');
  write('move, direction not a string', 'POST', move('size:M'), { direction: true }, 'owner');
  write(
    'move, a missing value',
    'POST',
    `/api/v1/attribute-values/${missing}/move/`,
    { direction: 'up' },
    'owner',
  );
  write(
    'move, a bad direction for a missing value',
    'POST',
    `/api/v1/attribute-values/${missing}/move/`,
    {},
    'owner',
  );
  write(
    'move, filtered out',
    'POST',
    `${move('size:M')}?attribute=${A('color')}`,
    { direction: 'up' },
    'owner',
  );
  // `request.data.get` on a list: a 500 in Django, copied.
  write('move, a list body', 'POST', move('size:M'), [], 'owner');

  // --- Size charts ----------------------------------------------------------------------
  for (const query of [
    '',
    `?attribute=${A('size')}`,
    `?attribute=${A('color')}`,
    '?attribute=bad',
    '?ordering=name',
    '?ordering=-position,-name',
    '?ordering=attribute,name',
    '?ordering=attribute__name,-name',
    '?ordering=rows',
    '?ordering=-rows',
    '?ordering=columns,name',
    '?ordering=product_count',
  ]) {
    read(`charts ${query || '(all)'}`, `/api/v1/size-charts/${query}`);
  }
  for (const [name, id] of chart) read(`chart ${name}`, `/api/v1/size-charts/${id}/`);
  read(
    'chart: ordering through rows, one row',
    `/api/v1/size-charts/${C("Men's tops")}/?ordering=rows`,
  );
  read('chart: filtered out', `/api/v1/size-charts/${C("Men's tops")}/?attribute=${A('color')}`);

  const charts = '/api/v1/size-charts/';
  const row = (key: string, ...cells: unknown[]) => ({ attribute_value: V(key), cells });
  write('create chart', 'POST', charts, {
    attribute: A('size'),
    name: 'Parity fresh',
    system: ' UK ',
    columns: ['Chest', ' Waist '],
    rows: [row('size:S', '80', ' 70 '), row('size:XS', '76', '')],
    notes: ' Loose. ',
    position: 3,
  });
  write('create chart, not a Size attribute', 'POST', charts, {
    attribute: A('color'),
    name: 'X',
    columns: ['A'],
    rows: [row('color:Parity Teal', '1')],
  });
  write('create chart, a name taken in any case', 'POST', charts, {
    attribute: A('size'),
    name: "MEN'S TOPS",
    columns: ['A'],
    rows: [row('size:S', '1')],
  });
  write('create chart, same name on another attribute', 'POST', charts, {
    attribute: A('parity-fit-size'),
    name: "Men's tops",
    columns: ['A'],
    rows: [row('parity-fit-size:Petite', '1')],
  });
  for (const [label, columns] of [
    ['none', []],
    ['missing', undefined],
    ['thirteen', Array.from({ length: 13 }, (_, i) => `C${i}`)],
    ['a blank heading', ['A', '  ']],
    ['a long heading', ['x'.repeat(41)]],
    ['twice in another case', ['UK', 'uk']],
    ['twice, sharp s', ['STRASSE', 'straße']],
  ] as [string, unknown][]) {
    write(`create chart, columns ${label}`, 'POST', charts, {
      attribute: A('size'),
      name: 'Columns',
      ...(columns === undefined ? {} : { columns }),
      rows: [row('size:S', '1')],
    });
  }
  for (const [label, rows] of [
    ['none', []],
    ['missing', undefined],
    ['another attribute', [row('color:Parity Teal', '1')]],
    ['twice', [row('size:S', '1'), row('size:S', '2')]],
    ['a short row', [row('size:S')]],
    ['no figures', [row('size:S', '  ')]],
    ['a long figure', [row('size:S', 'f'.repeat(33))]],
    [
      'shapes DRF refuses',
      [
        null,
        5,
        'x',
        {},
        { attribute_value: 'nope', cells: 'x' },
        { attribute_value: V('size:S'), cells: [null, 3, 4.5] },
      ],
    ],
    ['not a list', { a: 1 }],
  ] as [string, unknown][]) {
    write(`create chart, rows ${label}`, 'POST', charts, {
      attribute: A('size'),
      name: 'Rows',
      columns: ['A'],
      ...(rows === undefined ? {} : { rows }),
    });
  }
  write('create chart, long notes', 'POST', charts, {
    attribute: A('size'),
    name: 'Notes',
    columns: ['A'],
    rows: [row('size:S', '1')],
    notes: 'n'.repeat(2001),
  });
  write('create chart, long system', 'POST', charts, {
    attribute: A('size'),
    name: 'System',
    system: 's'.repeat(41),
    columns: ['A'],
    rows: [row('size:S', '1')],
  });
  write('create chart, no attribute or name', 'POST', charts, { columns: ['A'] });

  const kids = `/api/v1/size-charts/${C('Parity kids')}/`;
  write('rename chart', 'PATCH', kids, { name: 'Parity children', position: 2 });
  write('chart columns without its rows', 'PATCH', kids, { columns: ['Age'] });
  write('chart columns with its rows', 'PATCH', kids, {
    columns: ['Age'],
    rows: [row('size:XS', '4'), row('size:S', '6')],
  });
  write('chart to another attribute', 'PATCH', kids, { attribute: A('shoe-size') });
  write('chart, unchanged', 'PATCH', kids, { name: 'Parity kids', system: 'Kids' });
  write('chart, a row with no value', 'PATCH', kids, { rows: [{ cells: ['1', '2'] }] });
  write('replace chart', 'PUT', kids, {
    attribute: A('size'),
    name: 'Parity kids',
    columns: ['Age', 'Height'],
    rows: [row('size:XS', '4-5', '110')],
  });
  write('replace chart, no attribute', 'PUT', kids, { name: 'Parity kids' });
  write(
    'delete chart in use',
    'DELETE',
    `/api/v1/size-charts/${C("Men's tops")}/`,
    undefined,
    'admin',
  );
  write('delete unused chart', 'DELETE', kids, undefined, 'admin');
  write('delete chart, not a uuid', 'DELETE', '/api/v1/size-charts/abc/', undefined, 'admin');

  return cases;
}
