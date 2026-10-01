import { type DomNode, type ElementNode, parseFragment } from '../common/html5ever';
import { pyLen, pyStrip } from '../common/python';
import { rustUrlParses } from '../common/rust-url';

/**
 * `content.rich_text`: the HTML a site page may hold. Every body is cleaned
 * here before it is stored -- the XSS boundary for page bodies.
 *
 * Django calls `nh3.clean` (nh3 0.3.7, the Rust `ammonia` 4.1.4 over
 * html5ever 0.39). This is that pipeline: html5ever's fragment parse
 * (`common/html5ever.ts`), then ammonia's `clean_dom` and html5ever's
 * serializer, ported from their source with nh3's settings as Django passes
 * them. Its output is compared with nh3's over a generated corpus in
 * `test/unit/rich-text.spec.ts`.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'h2',
  'h3',
  'strong',
  'em',
  'u',
  's',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
]);

/** `attributes={"a": {"href"}}` replaces ammonia's per-tag list; its generic one stays. */
const TAG_ATTRIBUTES: Record<string, Set<string>> = { a: new Set(['href']) };
const GENERIC_ATTRIBUTES = new Set(['lang', 'title']);
const URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const LINK_REL = 'noopener noreferrer';
const CLEAN_CONTENT_TAGS = new Set(['script', 'style']);

export const MAX_BODY_CHARS = 100_000;

// --- ammonia's `clean_dom` ----------------------------------------------------------------

function isUrlAttr(element: string, attr: string): boolean {
  return (
    (element !== 'animate' && element !== 'set' && attr === 'href') ||
    (element !== 'animate' && element !== 'set' && attr === 'xlink:href') ||
    attr === 'src' ||
    (element === 'form' && attr === 'action') ||
    (element === 'object' && attr === 'data') ||
    ((element === 'button' || element === 'input') && attr === 'formaction') ||
    (element === 'a' && attr === 'ping') ||
    (element === 'video' && attr === 'poster')
  );
}

/**
 * rust-url's `Url::parse` as ammonia reads it: `relative` when no scheme
 * starts the input (`RelativeUrlWithoutBase`), else the lower-cased scheme of
 * a URL that parses (`common/rust-url.ts`), else `invalid`. The scheme is read
 * as rust-url reads it: C0 controls and spaces trimmed from both ends, tabs
 * and line breaks skipped anywhere.
 */
export function urlScheme(value: string): { relative: true } | { scheme: string | null } {
  // eslint-disable-next-line no-control-regex -- C0 controls and space, as rust-url trims them.
  const trimmed = value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(trimmed);
  if (!match) return { relative: true };
  const scheme = match[0].slice(0, -1).toLowerCase();
  // Only an allowed scheme's link survives, so only its parse is asked about.
  if (!URL_SCHEMES.has(scheme)) return { scheme };
  return { scheme: rustUrlParses(value) ? scheme : null };
}

function keepAttribute(tag: string, name: string, value: string): boolean {
  const whitelisted = GENERIC_ATTRIBUTES.has(name) || (TAG_ATTRIBUTES[tag]?.has(name) ?? false);
  if (!whitelisted) return false;
  if (!isUrlAttr(tag, name)) return true;
  const parsed = urlScheme(value);
  if ('relative' in parsed) return true;
  return parsed.scheme !== null && URL_SCHEMES.has(parsed.scheme);
}

/** `clean_child`: whether the node stays, its attributes filtered when it does. */
function cleanChild(node: DomNode): boolean {
  switch (node.kind) {
    case 'text':
      return true;
    case 'comment':
      return false; // strip_comments
    case 'document':
      return false;
    case 'element':
      if (!ALLOWED_TAGS.has(node.local)) return false;
      node.attrs = node.attrs.filter((attr) => keepAttribute(node.local, attr.local, attr.value));
      return true;
  }
}

/** `adjust_node_attributes`: every link gets `rel`; relative URLs pass through as they are. */
function adjustNodeAttributes(node: DomNode): void {
  if (node.kind !== 'element') return;
  if (node.local === 'a') node.attrs.push({ ns: '', prefix: null, local: 'rel', value: LINK_REL });
}

function cleanNodeContent(node: DomNode): boolean {
  return node.kind === 'element' && CLEAN_CONTENT_TAGS.has(node.local);
}

const SVG_TAGS = new Set(
  `a animate animateMotion animateTransform circle clipPath defs desc discard ellipse feBlend
   feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting
   feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR
   feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight
   feSpecularLighting feSpotLight feTile feTurbulence filter foreignObject g image line
   linearGradient marker mask metadata mpath path pattern polygon polyline radialGradient rect
   script set stop style svg switch symbol text textPath title tspan use view`.split(/\s+/),
);

const MATHML_TAGS = new Set(
  `abs and annotation annotation-xml apply approx arccos arccosh arccot arccoth arccsc arccsch
   arcsec arcsech arcsin arcsinh arctan arctanh arg bind bvar card cartesianproduct cbytes
   ceiling cerror ci cn codomain complexes compose condition conjugate cos cosh cot coth cs csc
   csch csymbol curl declare degree determinant diff divergence divide domain
   domainofapplication emptyset eq equivalent eulergamma exists exp exponentiale factorial
   factorof false floor fn forall gcd geq grad gt ident image imaginary imaginaryi implies in
   infinity int integers intersect interval inverse lambda laplacian lcm leq limit list ln log
   logbase lowlimit lt maction maligngroup malignmark math matrix matrixrow max mean median
   menclose merror mfenced mfrac mglyph mi min minus mlabeledtr mlongdiv mmultiscripts mn mo
   mode moment momentabout mover mpadded mphantom mprescripts mroot mrow ms mscarries
   mscarry msgroup msline mspace msqrt msrow mstack mstyle msub msubsup msup mtable mtd mtext
   mtr munder munderover naturalnumbers neq none not notanumber notin notprsubset notsubset or
   otherwise outerproduct partialdiff pi piece piecewise plus power primes product prsubset
   quotient rationals real reals reln rem root scalarproduct sdev sec sech selector semantics
   sep set setdiff share sin sinh span subset sum tan tanh tendsto times transpose true union
   uplimit variance vector vectorproduct xor`.split(/\s+/),
);

function isSvgTag(element: string): boolean {
  return SVG_TAGS.has(element);
}

function isMathmlTag(element: string): boolean {
  return MATHML_TAGS.has(element);
}

function isHtmlTag(element: string): boolean {
  return (
    (!isSvgTag(element) && !isMathmlTag(element)) ||
    ['title', 'style', 'font', 'a', 'script', 'span'].includes(element)
  );
}

/** `check_expected_namespace`: an element whose namespace changed where none may change goes. */
function checkExpectedNamespace(parent: DomNode, child: DomNode): boolean {
  if (parent.kind !== 'element' || child.kind !== 'element') return true;
  if (parent.ns === 'html' && child.ns === 'svg') return child.local === 'svg';
  if (parent.ns === 'html' && child.ns === 'mathml') return child.local === 'math';
  if (parent.ns === 'mathml' && child.ns !== 'mathml') {
    if (parent.local === 'annotation-xml') {
      const encodings = parent.attrs.filter((attr) => attr.local === 'encoding');
      if (
        child.ns === 'html' &&
        encodings.every(
          (attr) => attr.value === 'text/html' || attr.value === 'application/xhtml+xml',
        )
      ) {
        return isHtmlTag(child.local) && encodings.length === 1;
      }
      return child.local === 'svg' && child.ns === 'svg';
    }
    return (
      ['mi', 'mo', 'mn', 'ms', 'mtext'].includes(parent.local) &&
      (child.ns === 'html' ? isHtmlTag(child.local) : true)
    );
  }
  if (parent.ns === 'svg' && child.ns !== 'svg') {
    return (
      parent.local === 'foreignObject' && (child.ns === 'html' ? isHtmlTag(child.local) : true)
    );
  }
  if (child.ns === 'svg') return isSvgTag(child.local);
  if (child.ns === 'mathml') return isMathmlTag(child.local);
  if (child.ns === 'html') return isHtmlTag(child.local);
  return parent.ns === child.ns;
}

/**
 * `clean_dom`, iteratively as ammonia does it: a node that stays is moved
 * under its nearest kept ancestor; one that does not leaves its children to
 * that ancestor; `<script>`, `<style>` and a namespace switch go with their
 * whole subtree.
 */
function cleanDom(root: ElementNode): void {
  const stack: DomNode[] = root.children.reverse();
  root.children = [];
  while (stack.length) {
    const node = stack.pop() as DomNode;
    const parent = node.parent as DomNode;
    node.parent = null;
    const pass = cleanChild(node);
    adjustNodeAttributes(node);
    if (cleanNodeContent(node) || !checkExpectedNamespace(parent, node)) continue;
    if (pass) {
      node.parent = parent;
      parent.children.push(node);
    } else {
      for (const child of node.children) child.parent = parent;
    }
    const children = node.children;
    node.children = [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as DomNode);
  }
}

// --- html5ever's serializer ---------------------------------------------------------------

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '\u00a0': '&nbsp;',
  '"': '&quot;',
  '<': '&lt;',
  '>': '&gt;',
};

/** html5ever's `write_escaped`: `<` and `>` are escaped in attribute values too. */
function escape(text: string, attrMode: boolean): string {
  return text.replace(attrMode ? /[&\u00a0"<>]/g : /[&\u00a0<>]/g, (c) => ESCAPES[c] as string);
}

const RAW_TEXT_PARENTS = new Set([
  'style',
  'script',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
  'noscript',
]);

interface ElemInfo {
  htmlName: string | null;
  ignoreChildren: boolean;
}

function attrPrefix(ns: string): string {
  if (ns === '') return '';
  if (ns === 'xml') return 'xml:';
  if (ns === 'xlink') return 'xlink:';
  if (ns === 'xmlns') return 'xmlns:';
  return 'unknown_namespace:';
}

/**
 * rcdom's `serialize` over html5ever's `HtmlSerializer`, without recursion
 * (a page may nest thousands deep): a queue of opens and closes, and the
 * serializer's own stack of what each open element allows inside it. A void
 * element writes no end tag and none of its child elements -- though, as in
 * html5ever, their text.
 */
function serializeChildren(root: DomNode): string {
  const out: string[] = [];
  const stack: ElemInfo[] = [{ htmlName: null, ignoreChildren: false }];
  const parent = () => stack[stack.length - 1] as ElemInfo;
  type Op = { open: DomNode } | { close: ElementNode };
  const ops: Op[] = [];
  for (let i = root.children.length - 1; i >= 0; i--)
    ops.push({ open: root.children[i] as DomNode });
  while (ops.length) {
    const op = ops.pop() as Op;
    if ('close' in op) {
      const info = stack.pop() as ElemInfo;
      if (!info.ignoreChildren) out.push(`</${op.close.local}>`);
      continue;
    }
    const node = op.open;
    switch (node.kind) {
      case 'element': {
        const htmlName = node.ns === 'html' ? node.local : null;
        if (parent().ignoreChildren) {
          stack.push({ htmlName, ignoreChildren: true });
        } else {
          out.push(`<${node.local}`);
          for (const attr of node.attrs) {
            const name =
              attr.ns === 'xmlns' && attr.local === 'xmlns'
                ? 'xmlns'
                : attrPrefix(attr.ns) + attr.local;
            out.push(` ${name}="${escape(attr.value, true)}"`);
          }
          out.push('>');
          stack.push({
            htmlName,
            ignoreChildren: node.ns === 'html' && VOID_ELEMENTS.has(node.local),
          });
        }
        ops.push({ close: node });
        for (let i = node.children.length - 1; i >= 0; i--)
          ops.push({ open: node.children[i] as DomNode });
        break;
      }
      case 'text': {
        const name = parent().htmlName;
        out.push(
          name !== null && RAW_TEXT_PARENTS.has(name) ? node.text : escape(node.text, false),
        );
        break;
      }
      case 'comment':
        out.push(`<!--${node.text}-->`);
        break;
      case 'document':
        throw new Error("Can't serialize Document node itself");
    }
  }
  return out.join('');
}

/** `nh3.clean(value, tags=..., attributes=..., url_schemes=..., link_rel=..., strip_comments=True)`. */
export function nh3Clean(html: string): string {
  if (/[\ud800-\udfff]/u.test(html.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))) {
    // A lone surrogate cannot cross into Rust: PyO3 raises, and the view answers 500.
    throw new Error(
      "UnicodeEncodeError: 'utf-8' codec can't encode character: surrogates not allowed",
    );
  }
  const root = parseFragment(html);
  cleanDom(root);
  return serializeChildren(root);
}

// --- `content.rich_text.sanitize` ---------------------------------------------------------

const S =
  '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const EMPTY_PARAGRAPHS = new RegExp(`(?:<p>${S}*(?:<br${S}*/?>)?${S}*</p>${S}*)+$`);

/** Allow-listed HTML, with trailing empty paragraphs trimmed. Idempotent. */
export function sanitize(value: string | null | undefined): string {
  const cleaned = nh3Clean(value || '');
  return pyStrip(cleaned).replace(EMPTY_PARAGRAPHS, '');
}

/** `len(cleaned) > MAX_BODY_CHARS`, in code points as Python counts. */
export function tooLong(cleaned: string): boolean {
  return pyLen(cleaned) > MAX_BODY_CHARS;
}
