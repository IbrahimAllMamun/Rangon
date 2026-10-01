/**
 * html5ever 0.39's tree builder, ported statement by statement from
 * `src/tree_builder/{mod,rules,tag_sets}.rs`, with ammonia 4.1.4's `RcDom` as
 * its sink -- the parser `nh3.clean` runs, and so the tree Django's page
 * sanitiser cleans (`content.rich_text`).
 *
 * Why a port rather than parse5's own tree builder: html5ever follows the
 * HTML standard of 2025, where `<select>` no longer has insertion modes of its
 * own and takes `<p>`, `<div>` and the rest as content; parse5 8 still builds
 * the old tree. It also has deviations of its own that a sanitiser's output
 * depends on: its default scope leaves out MathML `annotation-xml`, its
 * special tags are HTML ones only, and a parse error between a `<pre>` and
 * its first line feed keeps the line feed. Every one of those is kept here.
 *
 * The tokenizer is parse5's: both follow the standard's tokenizer, and the
 * differential test (`test/unit/rich-text.spec.ts`) holds the two pipelines
 * to the same output over a generated corpus nh3 cleaned in the Django
 * container. The tree builder sets the tokenizer's state as html5ever's
 * returns do (`ToRawData`, `ToPlaintext`) and tells it when CDATA is allowed.
 */
import { Tokenizer, TokenizerMode, Token as P5 } from 'parse5';

// --- the DOM: ammonia's rcdom ---------------------------------------------------------------

export type Ns = 'html' | 'svg' | 'mathml' | '' | 'xlink' | 'xml' | 'xmlns';

export interface Attr {
  ns: Ns;
  prefix: string | null;
  local: string;
  value: string;
}

export type DomNode = DocumentNode | ElementNode | TextNode | CommentNode;

interface NodeBase {
  parent: DomNode | null;
  children: DomNode[];
}

export interface DocumentNode extends NodeBase {
  kind: 'document';
}

export interface ElementNode extends NodeBase {
  kind: 'element';
  ns: Ns;
  local: string;
  attrs: Attr[];
  templateContents: DocumentNode | null;
  annotationXmlIntegrationPoint: boolean;
  /** Which tag sets have been asked about this element, and which it is in (`cached`). */
  setsKnown: number;
  setsIn: number;
  /** How many times the element is on the stack of open elements (`ElementStack`). */
  onStack: number;
}

export interface TextNode extends NodeBase {
  kind: 'text';
  text: string;
}

export interface CommentNode extends NodeBase {
  kind: 'comment';
  text: string;
}

function documentNode(): DocumentNode {
  return { kind: 'document', parent: null, children: [] };
}

/** `create_element_with_flags`: a template gets its contents, `annotation-xml` its flag. */
function createElement(ns: Ns, local: string, attrs: Attr[]): ElementNode {
  return {
    kind: 'element',
    parent: null,
    children: [],
    ns,
    local,
    attrs,
    templateContents: ns === 'html' && local === 'template' ? documentNode() : null,
    setsKnown: 0,
    setsIn: 0,
    onStack: 0,
    annotationXmlIntegrationPoint:
      ns === 'mathml' &&
      local === 'annotation-xml' &&
      attrs.some(
        (attr) =>
          attr.ns === '' &&
          attr.local === 'encoding' &&
          (asciiLower(attr.value) === 'text/html' ||
            asciiLower(attr.value) === 'application/xhtml+xml'),
      ),
  };
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** rcdom's `append`: a parentless node made the last child. */
function appendNode(parent: DomNode, child: DomNode): void {
  if (child.parent) throw new Error('html5ever: child already has a parent');
  child.parent = parent;
  parent.children.push(child);
}

function parentAndIndex(target: DomNode): [DomNode, number] | null {
  const parent = target.parent;
  if (!parent) return null;
  const index = parent.children.indexOf(target);
  if (index === -1)
    throw new Error("html5ever: have parent but couldn't find in parent's children");
  return [parent, index];
}

function removeFromParent(target: DomNode): void {
  const found = parentAndIndex(target);
  if (!found) return;
  found[0].children.splice(found[1], 1);
  target.parent = null;
}

type NodeOrText = { node: DomNode } | { text: string };

/** `TreeSink::append`: text joins a text node already last, as rcdom does. */
function sinkAppend(parent: DomNode, child: NodeOrText): void {
  if ('text' in child) {
    const last = parent.children[parent.children.length - 1];
    if (last && last.kind === 'text') {
      last.text += child.text;
      return;
    }
    appendNode(parent, { kind: 'text', parent: null, children: [], text: child.text });
    return;
  }
  appendNode(parent, child.node);
}

function sinkAppendBeforeSibling(sibling: DomNode, child: NodeOrText): void {
  const found = parentAndIndex(sibling);
  if (!found) throw new Error('html5ever: append_before_sibling called on node without parent');
  const [parent, index] = found;
  let node: DomNode;
  if ('text' in child) {
    if (index > 0) {
      const previous = parent.children[index - 1] as DomNode;
      if (previous.kind === 'text') {
        previous.text += child.text;
        return;
      }
    }
    node = { kind: 'text', parent: null, children: [], text: child.text };
  } else {
    node = child.node;
  }
  removeFromParent(node);
  node.parent = parent;
  parent.children.splice(index, 0, node);
}

function sinkAppendBasedOnParentNode(element: DomNode, previous: DomNode, child: NodeOrText): void {
  if (element.parent) sinkAppendBeforeSibling(element, child);
  else sinkAppend(previous, child);
}

function addAttrsIfMissing(target: ElementNode, attrs: Attr[]): void {
  const key = (attr: Attr) => `${attr.prefix ?? ''}\u0000${attr.ns}\u0000${attr.local}`;
  const existing = new Set(target.attrs.map(key));
  for (const attr of attrs) if (!existing.has(key(attr))) target.attrs.push(attr);
}

function reparentChildren(node: DomNode, newParent: DomNode): void {
  for (const child of node.children) child.parent = newParent;
  newParent.children.push(...node.children);
  node.children = [];
}

// --- tokens -------------------------------------------------------------------------------

interface Tag {
  kind: 'start' | 'end';
  name: string;
  selfClosing: boolean;
  attrs: Attr[];
  /** Kind, name and attributes in a canonical order, for `equiv_modulo_attr_order` (`tagKey`). */
  attrKey?: string;
}

type Split = 'not' | 'ws' | 'notws';

type Token =
  | { t: 'tag'; tag: Tag }
  | { t: 'comment'; text: string }
  | { t: 'chars'; split: Split; text: string }
  | { t: 'null' }
  | { t: 'eof' };

type Mode =
  | 'Initial'
  | 'BeforeHtml'
  | 'BeforeHead'
  | 'InHead'
  | 'InHeadNoscript'
  | 'AfterHead'
  | 'InBody'
  | 'Text'
  | 'InTable'
  | 'InTableText'
  | 'InCaption'
  | 'InColumnGroup'
  | 'InTableBody'
  | 'InRow'
  | 'InCell'
  | 'InTemplate'
  | 'AfterBody'
  | 'InFrameset'
  | 'AfterFrameset'
  | 'AfterAfterBody'
  | 'AfterAfterFrameset';

type RawKind = 'rcdata' | 'rawtext' | 'script';

type Result =
  | { r: 'done' }
  | { r: 'ack' }
  | { r: 'split'; text: string }
  | { r: 'reprocess'; mode: Mode; token: Token }
  | { r: 'script' }
  | { r: 'plaintext' }
  | { r: 'raw'; kind: RawKind };

const DONE: Result = { r: 'done' };
const ACK: Result = { r: 'ack' };

type FormatEntry = { marker: true } | { marker: false; elem: ElementNode; tag: Tag };

type InsertionPoint =
  { lastChild: DomNode } | { foster: { element: ElementNode; previous: ElementNode } };

// --- tag sets (`tag_sets.rs`): HTML names only, unless they say otherwise ------------------

type Name = { ns: Ns; local: string; setsKnown: number; setsIn: number };
type TagSet = (name: Name) => boolean;

let nextSetBit = 0;

/**
 * A tag set whose answer is kept on the element: an element's name never
 * changes, and the scope checks walk the whole stack of open elements for
 * every block start tag -- quadratic in html5ever too, but a bit test here.
 */
function cached(set: TagSet): TagSet {
  const bit = 1 << nextSetBit++;
  return (name) => {
    if (name.setsKnown & bit) return (name.setsIn & bit) !== 0;
    const member = set(name);
    name.setsKnown |= bit;
    if (member) name.setsIn |= bit;
    return member;
  };
}

function htmlSet(...names: string[]): TagSet {
  const set = new Set(names);
  return (name) => name.ns === 'html' && set.has(name.local);
}

function plus(base: TagSet, ...names: string[]): TagSet {
  const extra = htmlSet(...names);
  return (name) => extra(name) || base(name);
}

function minus(base: TagSet, ...names: string[]): TagSet {
  const removed = htmlSet(...names);
  return (name) => !removed(name) && base(name);
}

const htmlDefaultScope = htmlSet(
  'applet',
  'caption',
  'html',
  'table',
  'td',
  'th',
  'marquee',
  'object',
  'select',
  'template',
);

function mathmlTextIntegrationPoint(name: Name): boolean {
  return name.ns === 'mathml' && ['mi', 'mo', 'mn', 'ms', 'mtext'].includes(name.local);
}

function svgHtmlIntegrationPoint(name: Name): boolean {
  return name.ns === 'svg' && ['foreignObject', 'desc', 'title'].includes(name.local);
}

const defaultScope: TagSet = cached(
  (name) =>
    htmlDefaultScope(name) || mathmlTextIntegrationPoint(name) || svgHtmlIntegrationPoint(name),
);
const listItemScope = cached(plus(defaultScope, 'ol', 'ul'));
const buttonScope = cached(plus(defaultScope, 'button'));
const tableScope = cached(htmlSet('html', 'table', 'template'));
const tableBodyContext = htmlSet('tbody', 'tfoot', 'thead', 'template', 'html');
const tableRowContext = htmlSet('tr', 'template', 'html');
const tdTh = htmlSet('td', 'th');
const cursoryImpliedEnd = cached(
  htmlSet('dd', 'dt', 'li', 'option', 'optgroup', 'p', 'rb', 'rp', 'rt', 'rtc'),
);
const thoroughImpliedEnd = plus(
  cursoryImpliedEnd,
  'caption',
  'colgroup',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
);
const headingTag = htmlSet('h1', 'h2', 'h3', 'h4', 'h5', 'h6');
const specialTag = cached(
  htmlSet(
    ...`address applet area article aside base basefont bgsound blockquote body br button caption
      center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form
      frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input isindex li link
      listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre
      script section select source style summary table tbody td template textarea tfoot th thead
      title tr track ul wbr xmp`.split(/\s+/),
  ),
);
const fosterTarget = htmlSet('table', 'tbody', 'tfoot', 'thead', 'tr');

/** Rust's `char::is_ascii_whitespace`: space, tab, LF, form feed, CR. */
function isAsciiWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
}

function anyNotWhitespace(text: string): boolean {
  for (const c of text) if (!isAsciiWhitespace(c)) return true;
  return false;
}

const SVG_TAG_NAMES: Record<string, string> = Object.fromEntries(
  `altGlyph altGlyphDef altGlyphItem animateColor animateMotion animateTransform clipPath feBlend
   feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting
   feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR
   feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight
   feSpecularLighting feSpotLight feTile feTurbulence foreignObject glyphRef linearGradient
   radialGradient textPath`
    .split(/\s+/)
    .map((name) => [name.toLowerCase(), name]),
);

const SVG_ATTRIBUTE_NAMES: Record<string, string> = Object.fromEntries(
  `attributeName attributeType baseFrequency baseProfile calcMode clipPathUnits diffuseConstant
   edgeMode filterUnits glyphRef gradientTransform gradientUnits kernelMatrix kernelUnitLength
   keyPoints keySplines keyTimes lengthAdjust limitingConeAngle markerHeight markerUnits
   markerWidth maskContentUnits maskUnits numOctaves pathLength patternContentUnits
   patternTransform patternUnits pointsAtX pointsAtY pointsAtZ preserveAlpha preserveAspectRatio
   primitiveUnits refX refY repeatCount repeatDur requiredExtensions requiredFeatures
   specularConstant specularExponent spreadMethod startOffset stdDeviation stitchTiles
   surfaceScale systemLanguage tableValues targetX targetY textLength viewBox viewTarget
   xChannelSelector yChannelSelector zoomAndPan`
    .split(/\s+/)
    .map((name) => [name.toLowerCase(), name]),
);

const FOREIGN_ATTRIBUTES: Record<string, [string | null, Ns, string]> = {
  'xlink:actuate': ['xlink', 'xlink', 'actuate'],
  'xlink:arcrole': ['xlink', 'xlink', 'arcrole'],
  'xlink:href': ['xlink', 'xlink', 'href'],
  'xlink:role': ['xlink', 'xlink', 'role'],
  'xlink:show': ['xlink', 'xlink', 'show'],
  'xlink:title': ['xlink', 'xlink', 'title'],
  'xlink:type': ['xlink', 'xlink', 'type'],
  'xml:lang': ['xml', 'xml', 'lang'],
  'xml:space': ['xml', 'xml', 'space'],
  xmlns: ['', 'xmlns', 'xmlns'],
  'xmlns:xlink': ['xmlns', 'xmlns', 'xlink'],
};

const is = (tag: Tag, kind: 'start' | 'end', ...names: string[]) =>
  tag.kind === kind && names.includes(tag.name);

// --- the stack of open elements ----------------------------------------------------------

/**
 * The stack of open elements, counting the HTML elements of each name on it,
 * so that "is a <p> in button scope?" answers at once when no <p> is open --
 * html5ever walks the whole stack every time, which a page of 40,000 nested
 * <div>s turns into seconds of a blocked event loop. The answers are the same.
 */
class ElementStack {
  private readonly items: ElementNode[] = [];
  private readonly counts = new Map<string, number>();

  get length(): number {
    return this.items.length;
  }

  get(index: number): ElementNode | undefined {
    return this.items[index];
  }

  /** Whether an HTML element with this name is open anywhere on the stack. */
  hasHtml(name: string): boolean {
    return (this.counts.get(name) ?? 0) > 0;
  }

  private count(elem: ElementNode, delta: number): void {
    elem.onStack += delta;
    if (elem.ns === 'html') this.counts.set(elem.local, (this.counts.get(elem.local) ?? 0) + delta);
  }

  push(elem: ElementNode): void {
    this.items.push(elem);
    this.count(elem, 1);
  }

  pop(): ElementNode | undefined {
    const elem = this.items.pop();
    if (elem) this.count(elem, -1);
    return elem;
  }

  truncate(length: number): void {
    while (this.items.length > length) this.pop();
  }

  removeAt(index: number): void {
    const [elem] = this.items.splice(index, 1);
    if (elem) this.count(elem, -1);
  }

  insertAt(index: number, elem: ElementNode): void {
    this.items.splice(index, 0, elem);
    this.count(elem, 1);
  }

  replaceAt(index: number, elem: ElementNode): void {
    const old = this.items[index];
    if (old) this.count(old, -1);
    this.items[index] = elem;
    this.count(elem, 1);
  }

  indexOf(elem: ElementNode): number {
    return this.items.indexOf(elem);
  }

  lastIndexOf(elem: ElementNode): number {
    return elem.onStack > 0 ? this.items.lastIndexOf(elem) : -1;
  }

  contains(elem: ElementNode): boolean {
    return elem.onStack > 0;
  }
}

// --- the tree builder ---------------------------------------------------------------------

export class TreeBuilder {
  readonly doc = documentNode();
  private mode: Mode = 'Initial';
  private origMode: Mode | null = null;
  private templateModes: Mode[] = [];
  private pendingTableText: [Split, string][] = [];
  private openElems = new ElementStack();
  private activeFormatting: FormatEntry[] = [];
  private headElem: ElementNode | null = null;
  private formElem: ElementNode | null = null;
  private framesetOk = true;
  ignoreLf = false;
  private fosterParenting = false;
  private readonly scriptingEnabled = true;
  private readonly quirks = false;

  constructor(private readonly contextElem: ElementNode) {
    if (contextElem.ns === 'html' && contextElem.local === 'template')
      this.templateModes.push('InTemplate');
    this.createRoot([]);
    this.mode = this.resetInsertionMode();
  }

  /** The html element the fragment was parsed into (`document.children[0]`). */
  get root(): ElementNode {
    return this.doc.children[0] as ElementNode;
  }

  /** `TokenSink::adjusted_current_node_present_but_not_in_html_namespace`: may CDATA start? */
  get foreignContent(): boolean {
    return this.openElems.length > 0 && this.adjustedCurrentNode().ns !== 'html';
  }

  // --- the token loop ---------------------------------------------------------------------

  /** `process_to_completion`, answering what the tokenizer must do next. */
  process(first: Token): Result {
    const more: Token[] = [];
    let token = first;
    for (;;) {
      const result = this.isForeign(token) ? this.stepForeign(token) : this.step(this.mode, token);
      switch (result.r) {
        case 'done':
        case 'ack': {
          const next = more.shift();
          if (!next) return DONE;
          token = next;
          break;
        }
        case 'reprocess':
          this.mode = result.mode;
          token = result.token;
          break;
        case 'split': {
          const [run, isWs] = popFrontCharRun(result.text);
          if (run === null) return DONE;
          token = { t: 'chars', split: isWs ? 'ws' : 'notws', text: run };
          const rest = result.text.slice(run.length);
          if (rest.length > 0) more.push({ t: 'chars', split: 'not', text: rest });
          break;
        }
        case 'script':
        case 'plaintext':
        case 'raw':
          return result;
      }
    }
  }

  private unexpected(): Result {
    return DONE;
  }

  private stopParsing(): Result {
    return DONE;
  }

  private toRawTextMode(kind: RawKind): Result {
    this.origMode = this.mode;
    this.mode = 'Text';
    return { r: 'raw', kind };
  }

  private parseRawData(tag: Tag, kind: RawKind): Result {
    this.insertElementFor(tag);
    return this.toRawTextMode(kind);
  }

  private currentNode(): ElementNode {
    const node = this.openElems.get(this.openElems.length - 1);
    if (!node) throw new Error('html5ever: no current element');
    return node;
  }

  private adjustedCurrentNode(): ElementNode {
    if (this.openElems.length === 1) return this.contextElem;
    return this.currentNode();
  }

  private currentNodeIn(set: TagSet): boolean {
    return set(this.currentNode());
  }

  private insertAppropriately(child: NodeOrText, override: ElementNode | null): void {
    this.insertAt(this.appropriatePlaceForInsertion(override), child);
  }

  private appropriatePlaceForInsertion(override: ElementNode | null): InsertionPoint {
    const target = override ?? this.currentNode();
    if (!(this.fosterParenting && fosterTarget(target))) {
      if (this.htmlElemNamed(target, 'template'))
        return { lastChild: target.templateContents as DocumentNode };
      return { lastChild: target };
    }
    for (let i = this.openElems.length - 1; i >= 0; i--) {
      const elem = this.openElems.get(i) as ElementNode;
      if (this.htmlElemNamed(elem, 'template'))
        return { lastChild: elem.templateContents as DocumentNode };
      if (this.htmlElemNamed(elem, 'table')) {
        const previous = this.openElems.get(i - 1);
        if (!previous) throw new Error('html5ever: table at the bottom of the stack');
        return { foster: { element: elem, previous } };
      }
    }
    return { lastChild: this.htmlElem() };
  }

  private insertAt(point: InsertionPoint, child: NodeOrText): void {
    if ('lastChild' in point) sinkAppend(point.lastChild, child);
    else sinkAppendBasedOnParentNode(point.foster.element, point.foster.previous, child);
  }

  // --- the adoption agency ------------------------------------------------------------------

  private positionInActiveFormatting(element: ElementNode): number {
    return this.activeFormatting.findIndex((entry) => !entry.marker && entry.elem === element);
  }

  /**
   * The first entry from the end back to the last marker, newest first, that
   * `test` accepts, with its index.
   */
  private findToMarker(
    test: (elem: ElementNode, tag: Tag) => boolean,
  ): [number, ElementNode, Tag] | null {
    for (let i = this.activeFormatting.length - 1; i >= 0; i--) {
      const entry = this.activeFormatting[i] as FormatEntry;
      if (entry.marker) return null;
      if (test(entry.elem, entry.tag)) return [i, entry.elem, entry.tag];
    }
    return null;
  }

  private adoptionAgency(subject: string): void {
    // 1.
    if (
      this.currentNodeNamed(subject) &&
      this.positionInActiveFormatting(this.currentNode()) === -1
    ) {
      this.pop();
      return;
    }

    // 2. 3. 4.
    for (let outer = 0; outer < 8; outer++) {
      // 5.
      const found = this.findToMarker((_, tag) => tag.name === subject);
      if (!found) {
        this.processEndTagInBody({ kind: 'end', name: subject, selfClosing: false, attrs: [] });
        return;
      }
      const [fmtElemIndex, fmtElem, fmtElemTag] = found;

      const fmtElemStackIndex = this.openElems.lastIndexOf(fmtElem);
      if (fmtElemStackIndex === -1) {
        this.activeFormatting.splice(fmtElemIndex, 1);
        return;
      }

      // 7.
      if (!this.inScope(defaultScope, (n) => n === fmtElem)) return;

      // 9.
      let furthestBlockIndex = -1;
      for (let i = fmtElemStackIndex; i < this.openElems.length; i++) {
        if (specialTag(this.openElems.get(i) as ElementNode)) {
          furthestBlockIndex = i;
          break;
        }
      }
      if (furthestBlockIndex === -1) {
        // 10.
        this.openElems.truncate(fmtElemStackIndex);
        this.activeFormatting.splice(fmtElemIndex, 1);
        return;
      }
      const furthestBlock = this.openElems.get(furthestBlockIndex) as ElementNode;

      // 11.
      const commonAncestor = this.openElems.get(fmtElemStackIndex - 1) as ElementNode;

      // 12.
      let bookmark: { replace: ElementNode } | { insertAfter: ElementNode } = {
        replace: fmtElem,
      };

      // 13.
      let node: ElementNode;
      let nodeIndex = furthestBlockIndex;
      let lastNode: ElementNode = furthestBlock;
      let innerCounter = 0;
      for (;;) {
        innerCounter += 1;
        nodeIndex -= 1;
        node = this.openElems.get(nodeIndex) as ElementNode;
        if (node === fmtElem) break;

        if (innerCounter > 3) {
          const position = this.positionInActiveFormatting(node);
          if (position !== -1) this.activeFormatting.splice(position, 1);
          this.openElems.removeAt(nodeIndex);
          continue;
        }

        const nodeFormattingIndex = this.positionInActiveFormatting(node);
        if (nodeFormattingIndex === -1) {
          this.openElems.removeAt(nodeIndex);
          continue;
        }

        const entry = this.activeFormatting[nodeFormattingIndex] as FormatEntry;
        if (entry.marker) throw new Error('html5ever: Found marker during adoption agency');
        const tag = entry.tag;
        const newElement = createElement('html', tag.name, cloneAttrs(tag.attrs));
        this.openElems.replaceAt(nodeIndex, newElement);
        this.activeFormatting[nodeFormattingIndex] = { marker: false, elem: newElement, tag };
        node = newElement;

        if (lastNode === furthestBlock) bookmark = { insertAfter: node };

        removeFromParent(lastNode);
        sinkAppend(node, { node: lastNode });
        lastNode = node;
      }

      // 14.
      removeFromParent(lastNode);
      this.insertAppropriately({ node: lastNode }, commonAncestor);

      // 15.
      const newElement = createElement('html', fmtElemTag.name, cloneAttrs(fmtElemTag.attrs));
      const newEntry: FormatEntry = { marker: false, elem: newElement, tag: fmtElemTag };

      // 16. 17.
      reparentChildren(furthestBlock, newElement);
      sinkAppend(furthestBlock, { node: newElement });

      // 18.
      if ('replace' in bookmark) {
        const index = this.positionInActiveFormatting(bookmark.replace);
        if (index === -1) throw new Error('html5ever: bookmark not found');
        this.activeFormatting[index] = newEntry;
      } else {
        const index = this.positionInActiveFormatting(bookmark.insertAfter);
        if (index === -1) throw new Error('html5ever: bookmark not found');
        this.activeFormatting.splice(index + 1, 0, newEntry);
        const oldIndex = this.positionInActiveFormatting(fmtElem);
        if (oldIndex === -1) throw new Error('html5ever: formatting element not found');
        this.activeFormatting.splice(oldIndex, 1);
      }

      // 19.
      this.removeFromStack(fmtElem);
      const newFurthestBlockIndex = this.openElems.indexOf(furthestBlock);
      if (newFurthestBlockIndex === -1) throw new Error('html5ever: furthest block missing');
      this.openElems.insertAt(newFurthestBlockIndex + 1, newElement);
    }
  }

  private push(elem: ElementNode): void {
    this.openElems.push(elem);
  }

  private pop(): ElementNode {
    const elem = this.openElems.pop();
    if (!elem) throw new Error('html5ever: no current element');
    return elem;
  }

  private removeFromStack(elem: ElementNode): void {
    const position = this.openElems.lastIndexOf(elem);
    if (position !== -1) this.openElems.removeAt(position);
  }

  private isMarkerOrOpen(entry: FormatEntry): boolean {
    return entry.marker || this.openElems.contains(entry.elem);
  }

  private reconstructActiveFormattingElements(): void {
    const last = this.activeFormatting[this.activeFormatting.length - 1];
    if (!last || this.isMarkerOrOpen(last)) return;

    let entryIndex = this.activeFormatting.length - 1;
    for (;;) {
      if (entryIndex === 0) break;
      entryIndex -= 1;
      if (this.isMarkerOrOpen(this.activeFormatting[entryIndex] as FormatEntry)) {
        entryIndex += 1;
        break;
      }
    }

    for (;;) {
      const entry = this.activeFormatting[entryIndex] as FormatEntry;
      if (entry.marker) throw new Error('html5ever: Found marker during reconstruction');
      const tag = entry.tag;
      const newElement = this.insertElement(true, 'html', tag.name, cloneAttrs(tag.attrs));
      this.activeFormatting[entryIndex] = { marker: false, elem: newElement, tag };
      if (entryIndex === this.activeFormatting.length - 1) break;
      entryIndex += 1;
    }
  }

  private htmlElem(): ElementNode {
    return this.openElems.get(0) as ElementNode;
  }

  private bodyElem(): ElementNode | null {
    if (this.openElems.length <= 1) return null;
    const node = this.openElems.get(1) as ElementNode;
    return this.htmlElemNamed(node, 'body') ? node : null;
  }

  private inScope(scope: TagSet, pred: (node: ElementNode) => boolean): boolean {
    for (let i = this.openElems.length - 1; i >= 0; i--) {
      const node = this.openElems.get(i) as ElementNode;
      if (pred(node)) return true;
      if (scope(node)) return false;
    }
    return false;
  }

  private htmlElemNamed(elem: ElementNode, name: string): boolean {
    return elem.ns === 'html' && elem.local === name;
  }

  private inHtmlElemNamed(name: string): boolean {
    return this.openElems.hasHtml(name);
  }

  private currentNodeNamed(name: string): boolean {
    return this.htmlElemNamed(this.currentNode(), name);
  }

  private inScopeNamed(scope: TagSet, name: string): boolean {
    if (!this.openElems.hasHtml(name)) return false;
    for (let i = this.openElems.length - 1; i >= 0; i--) {
      const node = this.openElems.get(i) as ElementNode;
      if (node.ns === 'html' && node.local === name) return true;
      if (scope(node)) return false;
    }
    return false;
  }

  private generateImpliedEndTags(set: TagSet): void {
    for (;;) {
      const elem = this.openElems.get(this.openElems.length - 1);
      if (!elem || !set(elem)) return;
      this.pop();
    }
  }

  private generateImpliedEndExcept(except: string): void {
    this.generateImpliedEndTags(
      (name) => !(name.ns === 'html' && name.local === except) && cursoryImpliedEnd(name),
    );
  }

  private popUntilCurrent(set: TagSet): void {
    while (!this.currentNodeIn(set)) this.openElems.pop();
  }

  private popUntil(pred: TagSet): number {
    let n = 0;
    for (;;) {
      n += 1;
      const elem = this.openElems.pop();
      if (!elem) break;
      if (pred(elem)) break;
    }
    return n;
  }

  private popUntilNamed(name: string): number {
    return this.popUntil((p) => p.ns === 'html' && p.local === name);
  }

  private expectToClose(name: string): void {
    this.popUntilNamed(name);
  }

  private closePElement(): void {
    this.generateImpliedEndTags(minus(cursoryImpliedEnd, 'p'));
    this.expectToClose('p');
  }

  private closePElementInButtonScope(): void {
    if (this.inScopeNamed(buttonScope, 'p')) this.closePElement();
  }

  private isTypeHidden(tag: Tag): boolean {
    const attr = tag.attrs.find((at) => at.ns === '' && at.local === 'type');
    return attr ? asciiLower(attr.value) === 'hidden' : false;
  }

  private fosterParentInBody(token: Token): Result {
    this.fosterParenting = true;
    const result = this.step('InBody', token);
    this.fosterParenting = false;
    return result;
  }

  private processCharsInTable(token: Token): Result {
    if (this.currentNodeIn(htmlSet('table', 'tbody', 'tfoot', 'thead', 'tr'))) {
      if (this.pendingTableText.length) throw new Error('html5ever: pending table text');
      this.origMode = this.mode;
      return { r: 'reprocess', mode: 'InTableText', token };
    }
    return this.fosterParentInBody(token);
  }

  private resetInsertionMode(): Mode {
    for (let i = this.openElems.length - 1; i >= 0; i--) {
      const last = i === 0;
      const node = last ? this.contextElem : (this.openElems.get(i) as ElementNode);
      if (node.ns !== 'html') continue;
      switch (node.local) {
        case 'td':
        case 'th':
          if (!last) return 'InCell';
          break;
        case 'tr':
          return 'InRow';
        case 'tbody':
        case 'thead':
        case 'tfoot':
          return 'InTableBody';
        case 'caption':
          return 'InCaption';
        case 'colgroup':
          return 'InColumnGroup';
        case 'table':
          return 'InTable';
        case 'template': {
          const mode = this.templateModes[this.templateModes.length - 1];
          if (!mode) throw new Error('html5ever: no template mode');
          return mode;
        }
        case 'head':
          if (!last) return 'InHead';
          break;
        case 'body':
          return 'InBody';
        case 'frameset':
          return 'InFrameset';
        case 'html':
          return this.headElem ? 'AfterHead' : 'BeforeHead';
      }
    }
    return 'InBody';
  }

  private closeTheCell(): void {
    this.generateImpliedEndTags(cursoryImpliedEnd);
    this.popUntil(tdTh);
    this.clearActiveFormattingToMarker();
  }

  private appendText(text: string): Result {
    this.insertAppropriately({ text }, null);
    return DONE;
  }

  private appendComment(text: string): Result {
    this.insertAppropriately({ node: commentNode(text) }, null);
    return DONE;
  }

  private appendCommentToDoc(text: string): Result {
    sinkAppend(this.doc, { node: commentNode(text) });
    return DONE;
  }

  private appendCommentToHtml(text: string): Result {
    sinkAppend(this.htmlElem(), { node: commentNode(text) });
    return DONE;
  }

  private createRoot(attrs: Attr[]): void {
    const elem = createElement('html', 'html', attrs);
    this.push(elem);
    sinkAppend(this.doc, { node: elem });
  }

  private insertElement(push: boolean, ns: Ns, name: string, attrs: Attr[]): ElementNode {
    const elem = createElement(ns, name, cloneAttrs(attrs));
    // Form association changes nothing in the tree, so it is not modelled.
    this.insertAt(this.appropriatePlaceForInsertion(null), { node: elem });
    if (push) this.push(elem);
    return elem;
  }

  private insertElementFor(tag: Tag): ElementNode {
    return this.insertElement(true, 'html', tag.name, tag.attrs);
  }

  private insertAndPopElementFor(tag: Tag): ElementNode {
    return this.insertElement(false, 'html', tag.name, tag.attrs);
  }

  private insertPhantom(name: string): ElementNode {
    return this.insertElement(true, 'html', name, []);
  }

  private createFormattingElementFor(tag: Tag): ElementNode {
    let firstMatch: number | null = null;
    let matches = 0;
    const key = tagKey(tag);
    for (let i = this.activeFormatting.length - 1; i >= 0; i--) {
      const entry = this.activeFormatting[i] as FormatEntry;
      if (entry.marker) break;
      if (tagKey(entry.tag) === key) {
        firstMatch = i;
        matches += 1;
      }
    }
    if (matches >= 3) this.activeFormatting.splice(firstMatch as number, 1);
    const elem = this.insertElement(true, 'html', tag.name, tag.attrs);
    this.activeFormatting.push({ marker: false, elem, tag });
    return elem;
  }

  private clearActiveFormattingToMarker(): void {
    for (;;) {
      const entry = this.activeFormatting.pop();
      if (!entry || entry.marker) break;
    }
  }

  private processEndTagInBody(tag: Tag): void {
    let matchIdx = -1;
    for (let i = this.openElems.length - 1; i >= 0; i--) {
      const elem = this.openElems.get(i) as ElementNode;
      if (this.htmlElemNamed(elem, tag.name)) {
        matchIdx = i;
        break;
      }
      if (specialTag(elem)) return;
    }
    if (matchIdx === -1) return;
    this.generateImpliedEndExcept(tag.name);
    this.openElems.truncate(matchIdx);
  }

  private handleMisnestedATags(): void {
    const found = this.findToMarker((n) => this.htmlElemNamed(n, 'a'));
    if (!found) return;
    const node = found[1];
    this.adoptionAgency('a');
    const index = this.positionInActiveFormatting(node);
    if (index !== -1) this.activeFormatting.splice(index, 1);
    this.removeFromStack(node);
  }

  private isForeign(token: Token): boolean {
    if (token.t === 'eof') return false;
    if (this.openElems.length === 0) return false;
    const current = this.adjustedCurrentNode();
    if (current.ns === 'html') return false;

    if (mathmlTextIntegrationPoint(current)) {
      if (token.t === 'chars' || token.t === 'null') return false;
      if (
        token.t === 'tag' &&
        token.tag.kind === 'start' &&
        token.tag.name !== 'mglyph' &&
        token.tag.name !== 'malignmark'
      )
        return false;
    }

    if (svgHtmlIntegrationPoint(current)) {
      if (token.t === 'chars' || token.t === 'null') return false;
      if (token.t === 'tag' && token.tag.kind === 'start') return false;
    }

    if (current.ns === 'mathml' && current.local === 'annotation-xml') {
      if (token.t === 'tag' && token.tag.kind === 'start' && token.tag.name === 'svg') return false;
      if (
        token.t === 'chars' ||
        token.t === 'null' ||
        (token.t === 'tag' && token.tag.kind === 'start')
      )
        return !this.adjustedCurrentNode().annotationXmlIntegrationPoint;
    }

    return true;
  }

  private enterForeign(tag: Tag, ns: Ns): Result {
    let attrs = tag.attrs;
    if (ns === 'mathml') attrs = adjustMathmlAttributes(attrs);
    else if (ns === 'svg') attrs = adjustSvgAttributes(attrs);
    attrs = adjustForeignAttributes(attrs);
    if (tag.selfClosing) {
      this.insertElement(false, ns, tag.name, attrs);
      return ACK;
    }
    this.insertElement(true, ns, tag.name, attrs);
    return DONE;
  }

  private foreignStartTag(tag: Tag): Result {
    const currentNs = this.adjustedCurrentNode().ns;
    let name = tag.name;
    let attrs = tag.attrs;
    if (currentNs === 'mathml') attrs = adjustMathmlAttributes(attrs);
    else if (currentNs === 'svg') {
      name = SVG_TAG_NAMES[name] ?? name;
      attrs = adjustSvgAttributes(attrs);
    }
    attrs = adjustForeignAttributes(attrs);
    if (tag.selfClosing) {
      this.insertElement(false, currentNs, name, attrs);
      return ACK;
    }
    this.insertElement(true, currentNs, name, attrs);
    return DONE;
  }

  private unexpectedStartTagInForeignContent(tag: Tag): Result {
    while (
      !this.currentNodeIn(
        (n) => n.ns === 'html' || mathmlTextIntegrationPoint(n) || svgHtmlIntegrationPoint(n),
      )
    ) {
      this.pop();
    }
    return this.step(this.mode, { t: 'tag', tag });
  }

  // --- the rules (`rules.rs`) -------------------------------------------------------------

  private step(mode: Mode, token: Token): Result {
    const tag = token.t === 'tag' ? token.tag : null;
    const start = (...names: string[]) => tag !== null && is(tag, 'start', ...names);
    const end = (...names: string[]) => tag !== null && is(tag, 'end', ...names);
    const anyStart = tag !== null && tag.kind === 'start';
    const anyEnd = tag !== null && tag.kind === 'end';
    const notSplit = token.t === 'chars' && token.split === 'not';
    const whitespace = token.t === 'chars' && token.split === 'ws';

    switch (mode) {
      case 'Initial': {
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return DONE;
        if (token.t === 'comment') return this.appendCommentToDoc(token.text);
        return { r: 'reprocess', mode: 'BeforeHtml', token };
      }

      case 'BeforeHtml': {
        const anythingElse = (): Result => {
          this.createRoot([]);
          return { r: 'reprocess', mode: 'BeforeHead', token };
        };
        if (token.t === 'comment') return this.appendCommentToDoc(token.text);
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return DONE;
        if (start('html')) {
          this.createRoot((tag as Tag).attrs);
          this.mode = 'BeforeHead';
          return DONE;
        }
        if (end('head', 'body', 'html', 'br')) return anythingElse();
        if (anyEnd) return this.unexpected();
        return anythingElse();
      }

      case 'BeforeHead': {
        const anythingElse = (): Result => {
          this.headElem = this.insertPhantom('head');
          return { r: 'reprocess', mode: 'InHead', token };
        };
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return DONE;
        if (token.t === 'comment') return this.appendComment(token.text);
        if (start('html')) return this.step('InBody', token);
        if (start('head')) {
          this.headElem = this.insertElementFor(tag as Tag);
          this.mode = 'InHead';
          return DONE;
        }
        if (end('head', 'body', 'html', 'br')) return anythingElse();
        if (anyEnd) return this.unexpected();
        return anythingElse();
      }

      case 'InHead': {
        const anythingElse = (): Result => {
          this.pop();
          return { r: 'reprocess', mode: 'AfterHead', token };
        };
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return this.appendText((token as { text: string }).text);
        if (token.t === 'comment') return this.appendComment(token.text);
        if (start('html')) return this.step('InBody', token);
        if (start('base', 'basefont', 'bgsound', 'link', 'meta')) {
          // The encoding indicators change nothing for a string already decoded.
          this.insertAndPopElementFor(tag as Tag);
          return ACK;
        }
        if (start('title')) return this.parseRawData(tag as Tag, 'rcdata');
        if (start('noframes', 'style', 'noscript')) {
          if (!this.scriptingEnabled && (tag as Tag).name === 'noscript') {
            this.insertElementFor(tag as Tag);
            this.mode = 'InHeadNoscript';
            return DONE;
          }
          return this.parseRawData(tag as Tag, 'rawtext');
        }
        if (start('script')) {
          const elem = createElement('html', 'script', cloneAttrs((tag as Tag).attrs));
          this.insertAppropriately({ node: elem }, null);
          this.openElems.push(elem);
          return this.toRawTextMode('script');
        }
        if (end('head')) {
          this.pop();
          this.mode = 'AfterHead';
          return DONE;
        }
        if (end('body', 'html', 'br')) return anythingElse();
        if (start('template')) {
          // A declarative shadow root is never attached (rcdom refuses it),
          // so the template goes in as an element either way.
          this.activeFormatting.push({ marker: true });
          this.framesetOk = false;
          this.mode = 'InTemplate';
          this.templateModes.push('InTemplate');
          this.insertElementFor(tag as Tag);
          return DONE;
        }
        if (end('template')) {
          if (this.inHtmlElemNamed('template')) {
            this.generateImpliedEndTags(thoroughImpliedEnd);
            this.expectToClose('template');
            this.clearActiveFormattingToMarker();
            this.templateModes.pop();
            this.mode = this.resetInsertionMode();
          }
          return DONE;
        }
        if (start('head') || anyEnd) return this.unexpected();
        return anythingElse();
      }

      case 'InHeadNoscript': {
        const anythingElse = (): Result => {
          this.pop();
          return { r: 'reprocess', mode: 'InHead', token };
        };
        if (start('html')) return this.step('InBody', token);
        if (end('noscript')) {
          this.pop();
          this.mode = 'InHead';
          return DONE;
        }
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return this.step('InHead', token);
        if (token.t === 'comment') return this.step('InHead', token);
        if (start('basefont', 'bgsound', 'link', 'meta', 'noframes', 'style'))
          return this.step('InHead', token);
        if (end('br')) return anythingElse();
        if (start('head', 'noscript') || anyEnd) return this.unexpected();
        return anythingElse();
      }

      case 'AfterHead': {
        const anythingElse = (): Result => {
          this.insertPhantom('body');
          return { r: 'reprocess', mode: 'InBody', token };
        };
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return this.appendText((token as { text: string }).text);
        if (token.t === 'comment') return this.appendComment(token.text);
        if (start('html')) return this.step('InBody', token);
        if (start('body')) {
          this.insertElementFor(tag as Tag);
          this.framesetOk = false;
          this.mode = 'InBody';
          return DONE;
        }
        if (start('frameset')) {
          this.insertElementFor(tag as Tag);
          this.mode = 'InFrameset';
          return DONE;
        }
        if (
          start(
            'base',
            'basefont',
            'bgsound',
            'link',
            'meta',
            'noframes',
            'script',
            'style',
            'template',
            'title',
          )
        ) {
          const head = this.headElem;
          if (!head) throw new Error('html5ever: no head element');
          this.push(head);
          const result = this.step('InHead', token);
          this.removeFromStack(head);
          return result;
        }
        if (end('template')) return this.step('InHead', token);
        if (end('body', 'html', 'br')) return anythingElse();
        if (start('head') || anyEnd) return this.unexpected();
        return anythingElse();
      }

      case 'InBody':
        return this.stepInBody(token);

      case 'Text': {
        if (token.t === 'chars') return this.appendText(token.text);
        if (token.t === 'eof') {
          this.pop();
          const orig = this.origMode;
          this.origMode = null;
          if (orig === null) throw new Error('html5ever: no original mode');
          return { r: 'reprocess', mode: orig, token };
        }
        if (anyEnd) {
          this.pop();
          const orig = this.origMode;
          this.origMode = null;
          if (orig === null) throw new Error('html5ever: no original mode');
          this.mode = orig;
          if ((tag as Tag).name === 'script') return { r: 'script' };
          return DONE;
        }
        throw new Error('html5ever: impossible case in Text mode');
      }

      case 'InTable': {
        if (token.t === 'null' || token.t === 'chars') return this.processCharsInTable(token);
        if (token.t === 'comment') return this.appendComment(token.text);
        if (start('caption')) {
          this.popUntilCurrent(tableScope);
          this.activeFormatting.push({ marker: true });
          this.insertElementFor(tag as Tag);
          this.mode = 'InCaption';
          return DONE;
        }
        if (start('colgroup')) {
          this.popUntilCurrent(tableScope);
          this.insertElementFor(tag as Tag);
          this.mode = 'InColumnGroup';
          return DONE;
        }
        if (start('col')) {
          this.popUntilCurrent(tableScope);
          this.insertPhantom('colgroup');
          return { r: 'reprocess', mode: 'InColumnGroup', token };
        }
        if (start('tbody', 'tfoot', 'thead')) {
          this.popUntilCurrent(tableScope);
          this.insertElementFor(tag as Tag);
          this.mode = 'InTableBody';
          return DONE;
        }
        if (start('td', 'th', 'tr')) {
          this.popUntilCurrent(tableScope);
          this.insertPhantom('tbody');
          return { r: 'reprocess', mode: 'InTableBody', token };
        }
        if (start('table')) {
          if (this.inScopeNamed(tableScope, 'table')) {
            this.popUntilNamed('table');
            return { r: 'reprocess', mode: this.resetInsertionMode(), token };
          }
          return DONE;
        }
        if (end('table')) {
          if (this.inScopeNamed(tableScope, 'table')) {
            this.popUntilNamed('table');
            this.mode = this.resetInsertionMode();
          }
          return DONE;
        }
        if (
          end(
            'body',
            'caption',
            'col',
            'colgroup',
            'html',
            'tbody',
            'td',
            'tfoot',
            'th',
            'thead',
            'tr',
          )
        )
          return this.unexpected();
        if (start('style', 'script', 'template') || end('template'))
          return this.step('InHead', token);
        if (start('input')) {
          if (this.isTypeHidden(tag as Tag)) {
            this.insertAndPopElementFor(tag as Tag);
            return ACK;
          }
          return this.fosterParentInBody(token);
        }
        if (start('form')) {
          if (!this.inHtmlElemNamed('template') && this.formElem === null)
            this.formElem = this.insertAndPopElementFor(tag as Tag);
          return DONE;
        }
        if (token.t === 'eof') return this.step('InBody', token);
        return this.fosterParentInBody(token);
      }

      case 'InTableText': {
        if (token.t === 'null') return this.unexpected();
        if (token.t === 'chars') {
          this.pendingTableText.push([token.split, token.text]);
          return DONE;
        }
        const pending = this.pendingTableText;
        this.pendingTableText = [];
        const containsNonspace = pending.some(([split, text]) =>
          split === 'ws' ? false : split === 'notws' ? true : anyNotWhitespace(text),
        );
        if (containsNonspace) {
          for (const [split, text] of pending) {
            const result = this.fosterParentInBody({ t: 'chars', split, text });
            if (result.r !== 'done') throw new Error('html5ever: not prepared to handle this!');
          }
        } else {
          for (const [, text] of pending) this.appendText(text);
        }
        const orig = this.origMode;
        this.origMode = null;
        if (orig === null) throw new Error('html5ever: no original mode');
        return { r: 'reprocess', mode: orig, token };
      }

      case 'InCaption': {
        if (
          start('caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr') ||
          end('table', 'caption')
        ) {
          if (this.inScopeNamed(tableScope, 'caption')) {
            this.generateImpliedEndTags(cursoryImpliedEnd);
            this.expectToClose('caption');
            this.clearActiveFormattingToMarker();
            if (end('caption')) {
              this.mode = 'InTable';
              return DONE;
            }
            return { r: 'reprocess', mode: 'InTable', token };
          }
          return this.unexpected();
        }
        if (end('body', 'col', 'colgroup', 'html', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr'))
          return this.unexpected();
        return this.step('InBody', token);
      }

      case 'InColumnGroup': {
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return this.appendText((token as { text: string }).text);
        if (token.t === 'comment') return this.appendComment(token.text);
        if (start('html')) return this.step('InBody', token);
        if (start('col')) {
          this.insertAndPopElementFor(tag as Tag);
          return ACK;
        }
        if (end('colgroup')) {
          if (this.currentNodeNamed('colgroup')) {
            this.pop();
            this.mode = 'InTable';
          }
          return DONE;
        }
        if (end('col')) return this.unexpected();
        if (start('template') || end('template')) return this.step('InHead', token);
        if (token.t === 'eof') return this.step('InBody', token);
        if (this.currentNodeNamed('colgroup')) {
          this.pop();
          return { r: 'reprocess', mode: 'InTable', token };
        }
        return this.unexpected();
      }

      case 'InTableBody': {
        if (start('tr')) {
          this.popUntilCurrent(tableBodyContext);
          this.insertElementFor(tag as Tag);
          this.mode = 'InRow';
          return DONE;
        }
        if (start('th', 'td')) {
          this.popUntilCurrent(tableBodyContext);
          this.insertPhantom('tr');
          return { r: 'reprocess', mode: 'InRow', token };
        }
        if (end('tbody', 'tfoot', 'thead')) {
          if (this.inScopeNamed(tableScope, (tag as Tag).name)) {
            this.popUntilCurrent(tableBodyContext);
            this.pop();
            this.mode = 'InTable';
          }
          return DONE;
        }
        if (start('caption', 'col', 'colgroup', 'tbody', 'tfoot', 'thead') || end('table')) {
          const tableOuter = htmlSet('table', 'tbody', 'tfoot');
          if (this.inScope(tableScope, (e) => tableOuter(e))) {
            this.popUntilCurrent(tableBodyContext);
            this.pop();
            return { r: 'reprocess', mode: 'InTable', token };
          }
          return this.unexpected();
        }
        if (end('body', 'caption', 'col', 'colgroup', 'html', 'td', 'th', 'tr'))
          return this.unexpected();
        return this.step('InTable', token);
      }

      case 'InRow': {
        if (start('th', 'td')) {
          this.popUntilCurrent(tableRowContext);
          this.insertElementFor(tag as Tag);
          this.mode = 'InCell';
          this.activeFormatting.push({ marker: true });
          return DONE;
        }
        if (end('tr')) {
          if (this.inScopeNamed(tableScope, 'tr')) {
            this.popUntilCurrent(tableRowContext);
            this.assertNamed(this.pop(), 'tr');
            this.mode = 'InTableBody';
          }
          return DONE;
        }
        if (start('caption', 'col', 'colgroup', 'tbody', 'tfoot', 'thead', 'tr') || end('table')) {
          if (this.inScopeNamed(tableScope, 'tr')) {
            this.popUntilCurrent(tableRowContext);
            this.assertNamed(this.pop(), 'tr');
            return { r: 'reprocess', mode: 'InTableBody', token };
          }
          return this.unexpected();
        }
        if (end('tbody', 'tfoot', 'thead')) {
          if (this.inScopeNamed(tableScope, (tag as Tag).name)) {
            if (this.inScopeNamed(tableScope, 'tr')) {
              this.popUntilCurrent(tableRowContext);
              this.assertNamed(this.pop(), 'tr');
              return { r: 'reprocess', mode: 'InTableBody', token };
            }
            return DONE;
          }
          return this.unexpected();
        }
        if (end('body', 'caption', 'col', 'colgroup', 'html', 'td', 'th')) return this.unexpected();
        return this.step('InTable', token);
      }

      case 'InCell': {
        if (end('td', 'th')) {
          if (this.inScopeNamed(tableScope, (tag as Tag).name)) {
            this.generateImpliedEndTags(cursoryImpliedEnd);
            this.expectToClose((tag as Tag).name);
            this.clearActiveFormattingToMarker();
            this.mode = 'InRow';
          }
          return DONE;
        }
        if (start('caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr')) {
          if (this.inScope(tableScope, (n) => tdTh(n))) {
            this.closeTheCell();
            return { r: 'reprocess', mode: 'InRow', token };
          }
          return this.unexpected();
        }
        if (end('body', 'caption', 'col', 'colgroup', 'html')) return this.unexpected();
        if (end('table', 'tbody', 'tfoot', 'thead', 'tr')) {
          if (this.inScopeNamed(tableScope, (tag as Tag).name)) {
            this.closeTheCell();
            return { r: 'reprocess', mode: 'InRow', token };
          }
          return this.unexpected();
        }
        return this.step('InBody', token);
      }

      case 'InTemplate': {
        if (token.t === 'chars' || token.t === 'comment') return this.step('InBody', token);
        if (
          start(
            'base',
            'basefont',
            'bgsound',
            'link',
            'meta',
            'noframes',
            'script',
            'style',
            'template',
            'title',
          ) ||
          end('template')
        )
          return this.step('InHead', token);
        const switchTo = (next: Mode): Result => {
          this.templateModes.pop();
          this.templateModes.push(next);
          return { r: 'reprocess', mode: next, token };
        };
        if (start('caption', 'colgroup', 'tbody', 'tfoot', 'thead')) return switchTo('InTable');
        if (start('col')) return switchTo('InColumnGroup');
        if (start('tr')) return switchTo('InTableBody');
        if (start('td', 'th')) return switchTo('InRow');
        if (token.t === 'eof') {
          if (!this.inHtmlElemNamed('template')) return this.stopParsing();
          this.popUntilNamed('template');
          this.clearActiveFormattingToMarker();
          this.templateModes.pop();
          this.mode = this.resetInsertionMode();
          return { r: 'reprocess', mode: this.resetInsertionMode(), token };
        }
        if (anyStart) return switchTo('InBody');
        return this.unexpected();
      }

      case 'AfterBody': {
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return this.step('InBody', token);
        if (token.t === 'comment') return this.appendCommentToHtml(token.text);
        if (start('html')) return this.step('InBody', token);
        if (end('html')) {
          // Always a fragment here.
          return this.unexpected();
        }
        if (token.t === 'eof') return this.stopParsing();
        return { r: 'reprocess', mode: 'InBody', token };
      }

      case 'InFrameset': {
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return this.appendText((token as { text: string }).text);
        if (token.t === 'comment') return this.appendComment(token.text);
        if (start('html')) return this.step('InBody', token);
        if (start('frameset')) {
          this.insertElementFor(tag as Tag);
          return DONE;
        }
        if (end('frameset')) {
          if (this.openElems.length !== 1) this.pop();
          // A fragment never leaves for "after frameset".
          return DONE;
        }
        if (start('frame')) {
          this.insertAndPopElementFor(tag as Tag);
          return ACK;
        }
        if (start('noframes')) return this.step('InHead', token);
        if (token.t === 'eof') return this.stopParsing();
        return this.unexpected();
      }

      case 'AfterFrameset': {
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return this.appendText((token as { text: string }).text);
        if (token.t === 'comment') return this.appendComment(token.text);
        if (start('html')) return this.step('InBody', token);
        if (end('html')) {
          this.mode = 'AfterAfterFrameset';
          return DONE;
        }
        if (start('noframes')) return this.step('InHead', token);
        if (token.t === 'eof') return this.stopParsing();
        return this.unexpected();
      }

      case 'AfterAfterBody': {
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return this.step('InBody', token);
        if (token.t === 'comment') return this.appendCommentToDoc(token.text);
        if (start('html')) return this.step('InBody', token);
        if (token.t === 'eof') return this.stopParsing();
        return { r: 'reprocess', mode: 'InBody', token };
      }

      case 'AfterAfterFrameset': {
        if (notSplit) return { r: 'split', text: (token as { text: string }).text };
        if (whitespace) return this.step('InBody', token);
        if (token.t === 'comment') return this.appendCommentToDoc(token.text);
        if (start('html')) return this.step('InBody', token);
        if (token.t === 'eof') return this.stopParsing();
        if (start('noframes')) return this.step('InHead', token);
        return this.unexpected();
      }
    }
  }

  private assertNamed(node: ElementNode, name: string): void {
    if (!this.htmlElemNamed(node, name)) throw new Error(`html5ever: expected <${name}>`);
  }

  private stepInBody(token: Token): Result {
    if (token.t === 'null') return this.unexpected();
    if (token.t === 'chars') {
      this.reconstructActiveFormattingElements();
      if (anyNotWhitespace(token.text)) this.framesetOk = false;
      return this.appendText(token.text);
    }
    if (token.t === 'comment') return this.appendComment(token.text);
    if (token.t === 'eof') {
      if (this.templateModes.length) return this.step('InTemplate', token);
      return this.stopParsing();
    }
    const tag = (token as { tag: Tag }).tag;
    const start = (...names: string[]) => is(tag, 'start', ...names);
    const end = (...names: string[]) => is(tag, 'end', ...names);

    if (start('html')) {
      if (!this.inHtmlElemNamed('template')) addAttrsIfMissing(this.htmlElem(), tag.attrs);
      return DONE;
    }
    if (
      start(
        'base',
        'basefont',
        'bgsound',
        'link',
        'meta',
        'noframes',
        'script',
        'style',
        'template',
        'title',
      ) ||
      end('template')
    )
      return this.step('InHead', token);
    if (start('body')) {
      const body = this.bodyElem();
      if (body && this.openElems.length !== 1 && !this.inHtmlElemNamed('template')) {
        this.framesetOk = false;
        addAttrsIfMissing(body, tag.attrs);
      }
      return DONE;
    }
    if (start('frameset')) {
      if (!this.framesetOk) return DONE;
      const body = this.bodyElem();
      if (!body) return DONE;
      removeFromParent(body);
      this.openElems.truncate(1);
      this.insertElementFor(tag);
      this.mode = 'InFrameset';
      return DONE;
    }
    if (end('body')) {
      if (this.inScopeNamed(defaultScope, 'body')) this.mode = 'AfterBody';
      return DONE;
    }
    if (end('html')) {
      if (this.inScopeNamed(defaultScope, 'body'))
        return { r: 'reprocess', mode: 'AfterBody', token };
      return DONE;
    }
    if (
      start(
        ...`address article aside blockquote center details dialog dir div dl fieldset figcaption
            figure footer header hgroup main nav ol p search section summary ul`.split(/\s+/),
      )
    ) {
      this.closePElementInButtonScope();
      this.insertElementFor(tag);
      return DONE;
    }
    if (start('menu')) {
      this.closePElementInButtonScope();
      this.insertElementFor(tag);
      return DONE;
    }
    if (start('h1', 'h2', 'h3', 'h4', 'h5', 'h6')) {
      this.closePElementInButtonScope();
      if (this.currentNodeIn(headingTag)) this.pop();
      this.insertElementFor(tag);
      return DONE;
    }
    if (start('pre', 'listing')) {
      this.closePElementInButtonScope();
      this.insertElementFor(tag);
      this.ignoreLf = true;
      this.framesetOk = false;
      return DONE;
    }
    if (start('form')) {
      if (this.formElem !== null && !this.inHtmlElemNamed('template')) return DONE;
      this.closePElementInButtonScope();
      const elem = this.insertElementFor(tag);
      if (!this.inHtmlElemNamed('template')) this.formElem = elem;
      return DONE;
    }
    if (start('li', 'dd', 'dt')) {
      const closeList = htmlSet('li');
      const closeDefn = htmlSet('dd', 'dt');
      const extraSpecial = minus(specialTag, 'address', 'div', 'p');
      const list = tag.name === 'li';
      this.framesetOk = false;
      let toClose: string | null = null;
      for (let i = this.openElems.length - 1; i >= 0; i--) {
        const node = this.openElems.get(i) as ElementNode;
        if (list ? closeList(node) : closeDefn(node)) {
          toClose = node.local;
          break;
        }
        if (extraSpecial(node)) break;
      }
      if (toClose !== null) {
        this.generateImpliedEndExcept(toClose);
        this.expectToClose(toClose);
      }
      this.closePElementInButtonScope();
      this.insertElementFor(tag);
      return DONE;
    }
    if (start('plaintext')) {
      this.closePElementInButtonScope();
      this.insertElementFor(tag);
      return { r: 'plaintext' };
    }
    if (start('button')) {
      if (this.inScopeNamed(defaultScope, 'button')) {
        this.generateImpliedEndTags(cursoryImpliedEnd);
        this.popUntilNamed('button');
      }
      this.reconstructActiveFormattingElements();
      this.insertElementFor(tag);
      this.framesetOk = false;
      return DONE;
    }
    if (
      end(
        ...`address article aside blockquote button center details dialog dir div dl fieldset
            figcaption figure footer header hgroup listing main menu nav ol pre search section
            select summary ul`.split(/\s+/),
      )
    ) {
      if (this.inScopeNamed(defaultScope, tag.name)) {
        this.generateImpliedEndTags(cursoryImpliedEnd);
        this.expectToClose(tag.name);
      }
      return DONE;
    }
    if (end('form')) {
      if (!this.inHtmlElemNamed('template')) {
        const node = this.formElem;
        this.formElem = null;
        if (!node) return DONE;
        if (!this.inScope(defaultScope, (n) => n === node)) return DONE;
        this.generateImpliedEndTags(cursoryImpliedEnd);
        this.removeFromStack(node);
      } else {
        if (!this.inScopeNamed(defaultScope, 'form')) return DONE;
        this.generateImpliedEndTags(cursoryImpliedEnd);
        this.popUntilNamed('form');
      }
      return DONE;
    }
    if (end('option')) {
      // `maybe_clone_an_option_into_selectedcontent` is a no-op in rcdom.
      this.processEndTagInBody(tag);
      return DONE;
    }
    if (end('p')) {
      if (!this.inScopeNamed(buttonScope, 'p')) this.insertPhantom('p');
      this.closePElement();
      return DONE;
    }
    if (end('li', 'dd', 'dt')) {
      const inScope =
        tag.name === 'li'
          ? this.inScopeNamed(listItemScope, tag.name)
          : this.inScopeNamed(defaultScope, tag.name);
      if (inScope) {
        this.generateImpliedEndExcept(tag.name);
        this.expectToClose(tag.name);
      }
      return DONE;
    }
    if (end('h1', 'h2', 'h3', 'h4', 'h5', 'h6')) {
      if (this.inScope(defaultScope, (n) => headingTag(n))) {
        this.generateImpliedEndTags(cursoryImpliedEnd);
        this.popUntil(headingTag);
      }
      return DONE;
    }
    if (start('a')) {
      this.handleMisnestedATags();
      this.reconstructActiveFormattingElements();
      this.createFormattingElementFor(tag);
      return DONE;
    }
    if (start('b', 'big', 'code', 'em', 'font', 'i', 's', 'small', 'strike', 'strong', 'tt', 'u')) {
      this.reconstructActiveFormattingElements();
      this.createFormattingElementFor(tag);
      return DONE;
    }
    if (start('nobr')) {
      this.reconstructActiveFormattingElements();
      if (this.inScopeNamed(defaultScope, 'nobr')) {
        this.adoptionAgency('nobr');
        this.reconstructActiveFormattingElements();
      }
      this.createFormattingElementFor(tag);
      return DONE;
    }
    if (
      end(
        'a',
        'b',
        'big',
        'code',
        'em',
        'font',
        'i',
        'nobr',
        's',
        'small',
        'strike',
        'strong',
        'tt',
        'u',
      )
    ) {
      this.adoptionAgency(tag.name);
      return DONE;
    }
    if (start('applet', 'marquee', 'object')) {
      this.reconstructActiveFormattingElements();
      this.insertElementFor(tag);
      this.activeFormatting.push({ marker: true });
      this.framesetOk = false;
      return DONE;
    }
    if (end('applet', 'marquee', 'object')) {
      if (this.inScopeNamed(defaultScope, tag.name)) {
        this.generateImpliedEndTags(cursoryImpliedEnd);
        this.expectToClose(tag.name);
        this.clearActiveFormattingToMarker();
      }
      return DONE;
    }
    if (start('table')) {
      if (!this.quirks) this.closePElementInButtonScope();
      this.insertElementFor(tag);
      this.framesetOk = false;
      this.mode = 'InTable';
      return DONE;
    }
    if (end('br')) {
      return this.step('InBody', {
        t: 'tag',
        tag: { kind: 'start', name: tag.name, selfClosing: tag.selfClosing, attrs: [] },
      });
    }
    if (start('area', 'br', 'embed', 'img', 'keygen', 'wbr')) {
      this.reconstructActiveFormattingElements();
      this.insertAndPopElementFor(tag);
      this.framesetOk = false;
      return ACK;
    }
    if (start('input')) {
      if (this.inScopeNamed(defaultScope, 'select')) this.popUntilNamed('select');
      const hidden = this.isTypeHidden(tag);
      this.reconstructActiveFormattingElements();
      this.insertAndPopElementFor(tag);
      if (!hidden) this.framesetOk = false;
      return ACK;
    }
    if (start('param', 'source', 'track')) {
      this.insertAndPopElementFor(tag);
      return ACK;
    }
    if (start('hr')) {
      this.closePElementInButtonScope();
      if (this.inScopeNamed(defaultScope, 'select')) this.generateImpliedEndTags(cursoryImpliedEnd);
      this.insertAndPopElementFor(tag);
      this.framesetOk = false;
      return ACK;
    }
    if (start('image')) {
      return this.step('InBody', { t: 'tag', tag: { ...tag, name: 'img' } });
    }
    if (start('textarea')) {
      this.ignoreLf = true;
      this.framesetOk = false;
      return this.parseRawData(tag, 'rcdata');
    }
    if (start('xmp')) {
      this.closePElementInButtonScope();
      this.reconstructActiveFormattingElements();
      this.framesetOk = false;
      return this.parseRawData(tag, 'rawtext');
    }
    if (start('iframe')) {
      this.framesetOk = false;
      return this.parseRawData(tag, 'rawtext');
    }
    if (start('noembed')) return this.parseRawData(tag, 'rawtext');
    if (start('select')) {
      if (this.contextElem.ns === 'html' && this.contextElem.local === 'select') return DONE;
      if (this.inScopeNamed(defaultScope, 'select')) {
        this.popUntilNamed('select');
      } else {
        this.reconstructActiveFormattingElements();
        this.insertElementFor(tag);
        this.framesetOk = false;
      }
      return DONE;
    }
    if (start('option')) {
      if (this.inScopeNamed(defaultScope, 'select')) {
        this.generateImpliedEndExcept('optgroup');
      } else if (this.currentNodeNamed('option')) {
        this.pop();
      }
      this.reconstructActiveFormattingElements();
      this.insertElementFor(tag);
      return DONE;
    }
    if (start('optgroup')) {
      if (this.inScopeNamed(defaultScope, 'select')) {
        this.generateImpliedEndTags(cursoryImpliedEnd);
      } else if (this.currentNodeNamed('option')) {
        this.pop();
      }
      this.reconstructActiveFormattingElements();
      this.insertElementFor(tag);
      return DONE;
    }
    if (start('rb', 'rtc')) {
      if (this.inScopeNamed(defaultScope, 'ruby')) this.generateImpliedEndTags(cursoryImpliedEnd);
      this.insertElementFor(tag);
      return DONE;
    }
    if (start('rp', 'rt')) {
      if (this.inScopeNamed(defaultScope, 'ruby')) this.generateImpliedEndExcept('rtc');
      this.insertElementFor(tag);
      return DONE;
    }
    if (start('math')) {
      this.reconstructActiveFormattingElements();
      return this.enterForeign(tag, 'mathml');
    }
    if (start('svg')) {
      this.reconstructActiveFormattingElements();
      return this.enterForeign(tag, 'svg');
    }
    if (
      start(
        'caption',
        'col',
        'colgroup',
        'frame',
        'head',
        'tbody',
        'td',
        'tfoot',
        'th',
        'thead',
        'tr',
      )
    )
      return this.unexpected();
    if (tag.kind === 'start') {
      if (this.scriptingEnabled && tag.name === 'noscript')
        return this.parseRawData(tag, 'rawtext');
      this.reconstructActiveFormattingElements();
      this.insertElementFor(tag);
      return DONE;
    }
    this.processEndTagInBody(tag);
    return DONE;
  }

  private stepForeign(token: Token): Result {
    if (token.t === 'null') return this.appendText('�');
    if (token.t === 'chars') {
      if (anyNotWhitespace(token.text)) this.framesetOk = false;
      return this.appendText(token.text);
    }
    if (token.t === 'comment') return this.appendComment(token.text);
    if (token.t === 'eof') throw new Error('html5ever: impossible case in foreign content');
    const tag = token.tag;
    if ((tag.kind === 'start' && BREAKOUT.has(tag.name)) || is(tag, 'end', 'br', 'p'))
      return this.unexpectedStartTagInForeignContent(tag);
    if (tag.kind === 'start' && tag.name === 'font') {
      const unexpected = tag.attrs.some(
        (attr) =>
          attr.ns === '' &&
          (attr.local === 'color' || attr.local === 'face' || attr.local === 'size'),
      );
      return unexpected ? this.unexpectedStartTagInForeignContent(tag) : this.foreignStartTag(tag);
    }
    if (tag.kind === 'start') return this.foreignStartTag(tag);

    let first = true;
    let stackIdx = this.openElems.length - 1;
    for (;;) {
      if (stackIdx === 0) return DONE;
      const node = this.openElems.get(stackIdx) as ElementNode;
      const html = node.ns === 'html';
      const eq = asciiLower(node.local) === asciiLower(tag.name);
      if (!first && html) return this.step(this.mode, token);
      if (eq) {
        this.openElems.truncate(stackIdx);
        return DONE;
      }
      first = false;
      stackIdx -= 1;
    }
  }
}

const BREAKOUT = new Set(
  `b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li
   listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var`.split(
    /\s+/,
  ),
);

function commentNode(text: string): CommentNode {
  return { kind: 'comment', parent: null, children: [], text };
}

function cloneAttrs(attrs: Attr[]): Attr[] {
  return attrs.map((attr) => ({ ...attr }));
}

/**
 * `Tag::equiv_modulo_attr_order` as a key: two tags are equivalent when their
 * kind, name and attributes -- in any order -- are the same, so when their
 * keys are.
 */
function tagKey(tag: Tag): string {
  tag.attrKey ??= JSON.stringify([
    tag.kind,
    tag.name,
    tag.attrs.map((attr) => JSON.stringify([attr.prefix, attr.ns, attr.local, attr.value])).sort(),
  ]);
  return tag.attrKey;
}

function adjustSvgAttributes(attrs: Attr[]): Attr[] {
  return attrs.map((attr) => {
    const local = SVG_ATTRIBUTE_NAMES[attr.local];
    return local ? { ns: '', prefix: null, local, value: attr.value } : attr;
  });
}

function adjustMathmlAttributes(attrs: Attr[]): Attr[] {
  return attrs.map((attr) =>
    attr.local === 'definitionurl'
      ? { ns: '', prefix: null, local: 'definitionURL', value: attr.value }
      : attr,
  );
}

function adjustForeignAttributes(attrs: Attr[]): Attr[] {
  return attrs.map((attr) => {
    const adjusted = FOREIGN_ATTRIBUTES[attr.local];
    if (!adjusted) return attr;
    const [prefix, ns, local] = adjusted;
    return { ns, prefix: prefix || null, local, value: attr.value };
  });
}

/** `StrTendril::pop_front_char_run(is_ascii_whitespace)`: the first run, and whether it is space. */
function popFrontCharRun(text: string): [string | null, boolean] {
  const first = text[0];
  if (first === undefined) return [null, false];
  const ws = isAsciiWhitespace(first);
  let i = 1;
  while (i < text.length && isAsciiWhitespace(text[i] as string) === ws) i++;
  return [text.slice(0, i), ws];
}

// --- the driver: `parse_fragment` with a <div> context, as ammonia makes its parser ----------

/**
 * Parse `html` as the children of a `<div>`: the html element that holds
 * them, with every node html5ever would build (`Parser::one`).
 */
export function parseFragment(html: string): ElementNode {
  const builder = new TreeBuilder(createElement('html', 'div', []));
  // html5ever's tokenizer discards one byte-order mark at the start (`discard_bom`).
  const input = html.startsWith('\ufeff') ? html.slice(1) : html;
  const deliver = (token: Token, endOffset?: number) => {
    const ignoreLf = builder.ignoreLf;
    builder.ignoreLf = false;
    if (token.t === 'chars') {
      let text = token.text;
      if (ignoreLf && text.startsWith('\n')) text = text.slice(1);
      if (!text) return;
      token = { ...token, text };
    }
    const result = builder.process(token);
    if (result.r === 'plaintext') tokenizer.state = TokenizerMode.PLAINTEXT;
    else if (result.r === 'raw')
      tokenizer.state =
        result.kind === 'rcdata'
          ? TokenizerMode.RCDATA
          : result.kind === 'rawtext'
            ? TokenizerMode.RAWTEXT
            : TokenizerMode.SCRIPT_DATA;
    tokenizer.inForeignNode = builder.foreignContent;
    // A line feed owed to a <pre>, <listing> or <textarea> is skipped only if
    // it is the next token. html5ever reports a numeric reference's missing
    // semicolon (or the end of input inside one) as a token of its own before
    // the character, so `<pre>&#10` keeps its line feed; parse5 reports it
    // after, so the case is read off the input here.
    if (builder.ignoreLf && endOffset !== undefined && OWED_LF_ERROR.test(input.slice(endOffset)))
      builder.ignoreLf = false;
  };
  const tag = (token: P5.TagToken, kind: 'start' | 'end'): Token => ({
    t: 'tag',
    tag: {
      kind,
      name: token.tagName,
      selfClosing: token.selfClosing,
      attrs: token.attrs.map((attr) => ({
        ns: '' as Ns,
        prefix: null,
        local: attr.name,
        value: attr.value,
      })),
    },
  });
  const tokenizer: Tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: true },
    {
      onComment: (token) => deliver({ t: 'comment', text: token.data }),
      // A DOCTYPE outside the initial mode is ignored, and a fragment never is in it.
      onDoctype: () => {
        builder.ignoreLf = false;
      },
      onStartTag: (token) => deliver(tag(token, 'start'), token.location?.endOffset),
      onEndTag: (token) => deliver(tag(token, 'end')),
      onEof: () => deliver({ t: 'eof' }),
      onCharacter: (token) => deliver({ t: 'chars', split: 'not', text: token.chars }),
      onWhitespaceCharacter: (token) => deliver({ t: 'chars', split: 'not', text: token.chars }),
      // html5ever sends one token per NUL.
      onNullCharacter: (token) => {
        for (let i = 0; i < token.chars.length; i++) deliver({ t: 'null' });
      },
      // An error html5ever passes through `process_token` takes the owed line
      // feed with it -- unless characters before it are still to be delivered,
      // which html5ever would have processed first.
      onParseError: () => {
        const pending = (tokenizer as unknown as { currentCharacterToken: unknown })
          .currentCharacterToken;
        if (!pending) builder.ignoreLf = false;
      },
    },
  );
  tokenizer.write(input, true);
  return builder.root;
}

/** A numeric reference to U+000A that html5ever reports as an error before emitting it. */
const OWED_LF_ERROR = /^&#(?:0*10(?![0-9;])|[xX]0*[aA](?![0-9a-fA-F;]))/;
