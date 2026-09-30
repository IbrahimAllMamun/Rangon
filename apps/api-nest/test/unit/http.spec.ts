import { splitDomainPort, validateHost } from '../../src/common/http';
import { filepathToUri, mediaUrl } from '../../src/common/media';
import { parseUuid } from '../../src/common/uuid';

describe('ALLOWED_HOSTS', () => {
  it.each([
    ['example.com:8000', ['example.com', '8000']],
    ['EXAMPLE.com.', ['example.com', '']],
    ['[::1]:80', ['[::1]', '80']],
    ['bad host!', ['', '']],
  ])('split_domain_port(%j)', (host, expected) => expect(splitDomainPort(host)).toEqual(expected));

  it('matches exact names, dot-prefixed subdomains and *', () => {
    expect(validateHost('shop.example.com', ['.example.com'])).toBe(true);
    expect(validateHost('example.com', ['.example.com'])).toBe(true);
    expect(validateHost('evil-example.com', ['.example.com'])).toBe(false);
    expect(validateHost('anything', ['*'])).toBe(true);
    expect(validateHost('api', ['localhost', 'API'])).toBe(true);
  });
});

describe('media URLs', () => {
  it('quote the file name as filepath_to_uri does', () => {
    expect(filepathToUri("a b/ñ~!*()'.jpg")).toBe("a%20b/%C3%B1~!*()'.jpg");
    expect(mediaUrl('products/x y.jpg')).toBe('/media/products/x%20y.jpg');
    expect(mediaUrl('')).toBe('');
    expect(mediaUrl(null)).toBe('');
  });
});

describe("Python's uuid.UUID()", () => {
  it('normalises the forms Python accepts, refuses the rest', () => {
    const canonical = '12345678-1234-5678-1234-567812345678';
    expect(parseUuid('12345678123456781234567812345678')).toBe(canonical);
    expect(parseUuid('{12345678-1234-5678-1234-567812345678}')).toBe(canonical);
    expect(parseUuid('urn:uuid:12345678-1234-5678-1234-567812345678')).toBe(canonical);
    expect(parseUuid('not-a-uuid')).toBeNull();
    expect(parseUuid(42)).toBeNull();
  });
});
