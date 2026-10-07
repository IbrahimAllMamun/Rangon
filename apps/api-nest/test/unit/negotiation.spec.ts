import { NotFound } from '../../src/common/errors';
import {
  BROWSABLE_RENDERER,
  JSON_RENDERER,
  NotAcceptable,
  parseMediaType,
  type Renderer,
  selectRenderer,
} from '../../src/http/negotiation';

const CSV: Renderer = { format: 'csv', mediaType: 'text/csv' };
const SETS: Record<string, Renderer[]> = {
  json: [JSON_RENDERER],
  'json,api': [JSON_RENDERER, BROWSABLE_RENDERER],
  'json,csv': [JSON_RENDERER, CSV],
  'csv,json': [CSV, JSON_RENDERER],
};

/**
 * Every expected value below was printed by DRF 3.15's
 * `DefaultContentNegotiation.select_renderer` in the Django container: the
 * format of the renderer it chose, 404 for `Http404`, 406 for `NotAcceptable`.
 * (The port was compared on 1,504 combinations before these were kept.)
 */
describe('content negotiation', () => {
  it.each<[string, string | undefined, string | undefined, string | number]>([
    ['json', undefined, undefined, 'json'],
    ['json', undefined, '', 406],
    ['json', undefined, '*/*', 'json'],
    ['json', undefined, 'application/json', 'json'],
    ['json', undefined, 'APPLICATION/JSON', 'json'],
    ['json', undefined, 'application/*', 'json'],
    ['json', undefined, '*/json', 'json'],
    ['json', undefined, 'text/csv', 406],
    ['json', undefined, 'text/html', 406],
    ['json', undefined, 'image/png', 406],
    ['json', undefined, 'json', 406],
    ['json', undefined, 'application/json; indent=4', 'json'],
    ['json', undefined, 'application/json;q=0', 'json'],
    ['json', undefined, 'text/csv, application/json', 'json'],
    ['json', undefined, 'text/csv;q=0.1, application/json;q=0.9', 'json'],
    ['json', undefined, 'text/*, application/json', 'json'],
    ['json', undefined, 'application/*, text/csv', 'json'],
    ['json', undefined, '*/*, text/csv', 'json'],
    ['json', undefined, 'application/json, text/csv; header=present', 'json'],
    ['json', undefined, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'json'],
    ['json', undefined, 'application/json; a="x;y"; b=1', 'json'],
    ['json', undefined, 'text/csv; q, application/json; q=1', 'json'],
    ['json', undefined, ',', 406],
    ['json', undefined, '*/*; a=1, application/json', 'json'],
    ['json,api', undefined, undefined, 'json'],
    ['json,api', undefined, '', 406],
    ['json,api', undefined, '*/*', 'json'],
    ['json,api', undefined, 'application/json', 'json'],
    ['json,api', undefined, 'APPLICATION/JSON', 'json'],
    ['json,api', undefined, 'application/*', 'json'],
    ['json,api', undefined, '*/json', 'json'],
    ['json,api', undefined, 'text/csv', 406],
    ['json,api', undefined, 'text/html', 'api'],
    ['json,api', undefined, 'image/png', 406],
    ['json,api', undefined, 'json', 406],
    ['json,api', undefined, 'application/json; indent=4', 'json'],
    ['json,api', undefined, 'application/json;q=0', 'json'],
    ['json,api', undefined, 'text/csv, application/json', 'json'],
    ['json,api', undefined, 'text/csv;q=0.1, application/json;q=0.9', 'json'],
    ['json,api', undefined, 'text/*, application/json', 'json'],
    ['json,api', undefined, 'application/*, text/csv', 'json'],
    ['json,api', undefined, '*/*, text/csv', 'json'],
    ['json,api', undefined, 'application/json, text/csv; header=present', 'json'],
    [
      'json,api',
      undefined,
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'api',
    ],
    ['json,api', undefined, 'application/json; a="x;y"; b=1', 'json'],
    ['json,api', undefined, 'text/csv; q, application/json; q=1', 'json'],
    ['json,api', undefined, ',', 406],
    ['json,api', undefined, '*/*; a=1, application/json', 'json'],
    ['json,csv', undefined, undefined, 'json'],
    ['json,csv', undefined, '', 406],
    ['json,csv', undefined, '*/*', 'json'],
    ['json,csv', undefined, 'application/json', 'json'],
    ['json,csv', undefined, 'APPLICATION/JSON', 'json'],
    ['json,csv', undefined, 'application/*', 'json'],
    ['json,csv', undefined, '*/json', 'json'],
    ['json,csv', undefined, 'text/csv', 'csv'],
    ['json,csv', undefined, 'text/html', 406],
    ['json,csv', undefined, 'image/png', 406],
    ['json,csv', undefined, 'json', 406],
    ['json,csv', undefined, 'application/json; indent=4', 'json'],
    ['json,csv', undefined, 'application/json;q=0', 'json'],
    ['json,csv', undefined, 'text/csv, application/json', 'json'],
    ['json,csv', undefined, 'text/csv;q=0.1, application/json;q=0.9', 'json'],
    ['json,csv', undefined, 'text/*, application/json', 'json'],
    ['json,csv', undefined, 'application/*, text/csv', 'csv'],
    ['json,csv', undefined, '*/*, text/csv', 'csv'],
    ['json,csv', undefined, 'application/json, text/csv; header=present', 'csv'],
    [
      'json,csv',
      undefined,
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'json',
    ],
    ['json,csv', undefined, 'application/json; a="x;y"; b=1', 'json'],
    ['json,csv', undefined, 'text/csv; q, application/json; q=1', 'json'],
    ['json,csv', undefined, ',', 406],
    ['json,csv', undefined, '*/*; a=1, application/json', 'json'],
    ['csv,json', undefined, undefined, 'csv'],
    ['csv,json', undefined, '', 406],
    ['csv,json', undefined, '*/*', 'csv'],
    ['csv,json', undefined, 'application/json', 'json'],
    ['csv,json', undefined, 'APPLICATION/JSON', 'json'],
    ['csv,json', undefined, 'application/*', 'json'],
    ['csv,json', undefined, '*/json', 'json'],
    ['csv,json', undefined, 'text/csv', 'csv'],
    ['csv,json', undefined, 'text/html', 406],
    ['csv,json', undefined, 'image/png', 406],
    ['csv,json', undefined, 'json', 406],
    ['csv,json', undefined, 'application/json; indent=4', 'json'],
    ['csv,json', undefined, 'application/json;q=0', 'json'],
    ['csv,json', undefined, 'text/csv, application/json', 'csv'],
    ['csv,json', undefined, 'text/csv;q=0.1, application/json;q=0.9', 'csv'],
    ['csv,json', undefined, 'text/*, application/json', 'json'],
    ['csv,json', undefined, 'application/*, text/csv', 'csv'],
    ['csv,json', undefined, '*/*, text/csv', 'csv'],
    ['csv,json', undefined, 'application/json, text/csv; header=present', 'csv'],
    [
      'csv,json',
      undefined,
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'csv',
    ],
    ['csv,json', undefined, 'application/json; a="x;y"; b=1', 'json'],
    ['csv,json', undefined, 'text/csv; q, application/json; q=1', 'csv'],
    ['csv,json', undefined, ',', 406],
    ['csv,json', undefined, '*/*; a=1, application/json', 'json'],
    ['json', '', undefined, 'json'],
    ['json', 'json', undefined, 'json'],
    ['json', 'csv', undefined, 404],
    ['json', 'api', undefined, 404],
    ['json', 'JSON', undefined, 404],
    ['json', 'xml', undefined, 404],
    ['json', ' json', undefined, 404],
    ['json,api', '', undefined, 'json'],
    ['json,api', 'json', undefined, 'json'],
    ['json,api', 'csv', undefined, 404],
    ['json,api', 'api', undefined, 'api'],
    ['json,api', 'JSON', undefined, 404],
    ['json,api', 'xml', undefined, 404],
    ['json,api', ' json', undefined, 404],
    ['json,csv', '', undefined, 'json'],
    ['json,csv', 'json', undefined, 'json'],
    ['json,csv', 'csv', undefined, 'csv'],
    ['json,csv', 'api', undefined, 404],
    ['json,csv', 'JSON', undefined, 404],
    ['json,csv', 'xml', undefined, 404],
    ['json,csv', ' json', undefined, 404],
    ['csv,json', '', undefined, 'csv'],
    ['csv,json', 'json', undefined, 'json'],
    ['csv,json', 'csv', undefined, 'csv'],
    ['csv,json', 'api', undefined, 404],
    ['csv,json', 'JSON', undefined, 404],
    ['csv,json', 'xml', undefined, 404],
    ['csv,json', ' json', undefined, 404],
    ['json,csv', 'csv', 'application/json', 406],
    ['json,csv', 'csv', 'text/*', 'csv'],
    ['json,csv', 'csv', 'image/png', 406],
  ])('renderers %j, format %j, Accept %j: %j', (set, format, accept, expected) => {
    let got: string | number;
    try {
      got = selectRenderer(SETS[set] as Renderer[], format, accept).format;
    } catch (error) {
      got = error instanceof NotFound ? 404 : error instanceof NotAcceptable ? 406 : 'threw';
    }
    expect(got).toBe(expected);
  });

  it('reads a media type as parse_header_parameters does', () => {
    expect(parseMediaType(' Application/JSON ; Indent=4; q=1; indent=2 ')).toEqual({
      mainType: 'application',
      subType: 'json',
      params: ['indent', 'q'],
    });
    // A semicolon inside quotes does not end a parameter; one with no `=` is no parameter.
    expect(parseMediaType('text/csv; a="x;y"; flag; b*=1').params).toEqual(['a', 'b']);
    expect(parseMediaType('json')).toEqual({ mainType: 'json', subType: '', params: [] });
  });
});
