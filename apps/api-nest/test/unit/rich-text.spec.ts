/**
 * `content.rich_text`: nh3 0.3.7 (ammonia 4.1.4 over html5ever 0.39, rust-url
 * 2.5.8 and idna 1.1 for links) and the trim Django adds. Expected values
 * printed by `nh3.clean` and `rich_text.sanitize` in the Django container.
 * Before it was committed the port was also compared with nh3 on 150,000
 * generated fragments (tables, formatting soup, <select>, SVG and MathML,
 * raw-text elements, character references) and 520,000 generated links
 * (IDN hosts, Punycode, bidi labels, IPv4 and IPv6, ports, user info): no
 * difference.
 */
import { nh3Clean, sanitize, tooLong } from '../../src/content/rich-text';

describe('nh3.clean and sanitize', () => {
  it.each([
    [
      '<p>Hello <strong>world</strong></p>',
      '<p>Hello <strong>world</strong></p>',
      '<p>Hello <strong>world</strong></p>',
    ],
    [
      '<h2>Returns</h2><p>Within <em>7 days</em>.</p><ul><li>One</li><li>Two</li></ul>',
      '<h2>Returns</h2><p>Within <em>7 days</em>.</p><ul><li>One</li><li>Two</li></ul>',
      '<h2>Returns</h2><p>Within <em>7 days</em>.</p><ul><li>One</li><li>Two</li></ul>',
    ],
    [
      '<p>৳ 1,290 — <u>VAT</u> <s>included</s></p><blockquote>Quote</blockquote><hr><ol><li>x</li></ol>',
      '<p>৳ 1,290 — <u>VAT</u> <s>included</s></p><blockquote>Quote</blockquote><hr><ol><li>x</li></ol>',
      '<p>৳ 1,290 — <u>VAT</u> <s>included</s></p><blockquote>Quote</blockquote><hr><ol><li>x</li></ol>',
    ],
    [
      '<p><a href="/contact">Contact</a> · <a href="https://rangon.test/a?b=1&amp;c=2">Shop</a></p>',
      '<p><a href="/contact" rel="noopener noreferrer">Contact</a> · <a href="https://rangon.test/a?b=1&amp;c=2" rel="noopener noreferrer">Shop</a></p>',
      '<p><a href="/contact" rel="noopener noreferrer">Contact</a> · <a href="https://rangon.test/a?b=1&amp;c=2" rel="noopener noreferrer">Shop</a></p>',
    ],
    [
      '<p><a href="mailto:hello@rangon.test">Mail</a> <a href="tel:+8801712345678">Call</a></p>',
      '<p><a href="mailto:hello@rangon.test" rel="noopener noreferrer">Mail</a> <a href="tel:+8801712345678" rel="noopener noreferrer">Call</a></p>',
      '<p><a href="mailto:hello@rangon.test" rel="noopener noreferrer">Mail</a> <a href="tel:+8801712345678" rel="noopener noreferrer">Call</a></p>',
    ],
    [
      '<p>Line<br>break</p><p></p><p><br></p>  ',
      '<p>Line<br>break</p><p></p><p><br></p>  ',
      '<p>Line<br>break</p>',
    ],
    [
      '<p>Text</p>\n<p> </p>\n<p><br/></p>\n',
      '<p>Text</p>\n<p> </p>\n<p><br></p>\n',
      '<p>Text</p>\n',
    ],
    [
      '<h1>Title</h1><h4>Small</h4><div>block</div><span>inline</span>',
      'TitleSmallblockinline',
      'TitleSmallblockinline',
    ],
    [
      '<p style="color:red" class="x" id="y" onclick="z()" title="t" lang="bn">kept</p>',
      '<p title="t" lang="bn">kept</p>',
      '<p title="t" lang="bn">kept</p>',
    ],
    ['<script>alert(1)</script><style>p{}</style>after', 'after', 'after'],
    ['<img src=x onerror=alert(1)>', '', ''],
    [
      '<a href="javascript:alert(1)">x</a><a href=" JaVaScRiPt:alert(1)">y</a><a href="java&#x09;script:alert(1)">z</a>',
      '<a rel="noopener noreferrer">x</a><a rel="noopener noreferrer">y</a><a rel="noopener noreferrer">z</a>',
      '<a rel="noopener noreferrer">x</a><a rel="noopener noreferrer">y</a><a rel="noopener noreferrer">z</a>',
    ],
    [
      '<a href="data:text/html,<b>">d</a><a href="vbscript:x">v</a><a href="ftp://x/">f</a>',
      '<a rel="noopener noreferrer">d</a><a rel="noopener noreferrer">v</a><a rel="noopener noreferrer">f</a>',
      '<a rel="noopener noreferrer">d</a><a rel="noopener noreferrer">v</a><a rel="noopener noreferrer">f</a>',
    ],
    [
      '<a href="x" rel="nofollow" target="_blank">r</a>',
      '<a href="x" rel="noopener noreferrer">r</a>',
      '<a href="x" rel="noopener noreferrer">r</a>',
    ],
    ['<!-- comment --><p>a<!-- inner -->b</p>', '<p>ab</p>', '<p>ab</p>'],
    ['<iframe src="https://evil"></iframe><object data=x></object><embed src=x>', '', ''],
    ['<form action=x><input name=a><button>b</button></form>', 'b', 'b'],
    [
      '<custom-el>gone with its text?</custom-el><foo>kept</foo>',
      'gone with its text?kept',
      'gone with its text?kept',
    ],
    ['<svg><a href="https://x">svg link</a></svg><math><mi>x</mi></math>', '', ''],
    ['<svg><p>breaks out</p></svg>', '<p>breaks out</p>', '<p>breaks out</p>'],
    ['<math><mtext><p>html in mtext</p></mtext></math>', '', ''],
    ['<math><annotation-xml encoding="text/html"><p>x</p></annotation-xml></math>', '', ''],
    [
      '<noscript><p>scripting on</p></noscript>',
      '&lt;p&gt;scripting on&lt;/p&gt;',
      '&lt;p&gt;scripting on&lt;/p&gt;',
    ],
    ['<template><p>inside template</p></template>after', 'after', 'after'],
    [
      '<textarea><p>raw</p></textarea><title><b>t</b></title><xmp><i>x</i></xmp>',
      '&lt;p&gt;raw&lt;/p&gt;&lt;b&gt;t&lt;/b&gt;&lt;i&gt;x&lt;/i&gt;',
      '&lt;p&gt;raw&lt;/p&gt;&lt;b&gt;t&lt;/b&gt;&lt;i&gt;x&lt;/i&gt;',
    ],
    ['<p>one<p>two<div>three', '<p>one</p><p>two</p>three', '<p>one</p><p>two</p>three'],
    ['<b><p>misnested</b> text</p>', '<p>misnested text</p>', '<p>misnested text</p>'],
    [
      '<a href="/1">one<a href="/2">two</a>',
      '<a href="/1" rel="noopener noreferrer">one</a><a href="/2" rel="noopener noreferrer">two</a>',
      '<a href="/1" rel="noopener noreferrer">one</a><a href="/2" rel="noopener noreferrer">two</a>',
    ],
    [
      '<strong><em>a</strong>b</em>',
      '<strong><em>a</em></strong><em>b</em>',
      '<strong><em>a</em></strong><em>b</em>',
    ],
    [
      '<table><tr><td>cell<p>para</td></tr>text</table>',
      'textcell<p>para</p>',
      'textcell<p>para</p>',
    ],
    [
      '<table><strong>fostered</strong><tr><td>x</td></tr></table>',
      '<strong>fostered</strong>x',
      '<strong>fostered</strong>x',
    ],
    ['<select><option>a<p>b</p></option></select>', 'a<p>b</p>', 'a<p>b</p>'],
    ['<select><div>in select</div><hr><option>x</select>', 'in select<hr>x', 'in select<hr>x'],
    [
      '<ul><li>one<li>two<ul><li>nested</ul></ul>',
      '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>',
      '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>',
    ],
    ['<h2>a<h3>b</h2>c', '<h2>a</h2><h3>b</h3>c', '<h2>a</h2><h3>b</h3>c'],
    ['<pre>\nfirst line kept?</pre>', 'first line kept?', 'first line kept?'],
    ['<pre>&#10;x</pre><pre>&#10x</pre><textarea>\n\ny</textarea>', 'x\nx\ny', 'x\nx\ny'],
    ['﻿<p>byte order mark</p>', '<p>byte order mark</p>', '<p>byte order mark</p>'],
    ['<p>\u0000null\u0000</p>', '<p>null</p>', '<p>null</p>'],
    ['<p>a\r\nb\rc</p>', '<p>a\nb\nc</p>', '<p>a\nb\nc</p>'],
    [
      '<p>&amp; &lt; &gt; &quot; &nbsp; &copy &notin; &noti; &#128512; &#x110000;</p>',
      '<p>&amp; &lt; &gt; " &nbsp; © ∉ ¬i; 😀 �</p>',
      '<p>&amp; &lt; &gt; " &nbsp; © ∉ ¬i; 😀 �</p>',
    ],
    [
      "<p title='a\"b&amp;c<d>'>attr</p>",
      '<p title="a&quot;b&amp;c&lt;d&gt;">attr</p>',
      '<p title="a&quot;b&amp;c&lt;d&gt;">attr</p>',
    ],
    ['</p>stray close<br/>', '<p></p>stray close<br>', '<p></p>stray close<br>'],
    ['<![CDATA[ not in html ]]><svg><![CDATA[ in svg ]]></svg>', ' in svg ', 'in svg'],
    [
      '<p>unclosed <strong>bold',
      '<p>unclosed <strong>bold</strong></p>',
      '<p>unclosed <strong>bold</strong></p>',
    ],
    [
      '<a href="https://ä.com">idn</a>',
      '<a href="https://ä.com" rel="noopener noreferrer">idn</a>',
      '<a href="https://ä.com" rel="noopener noreferrer">idn</a>',
    ],
    [
      '<a href="https://xn--bcher-kva.example">puny</a>',
      '<a href="https://xn--bcher-kva.example" rel="noopener noreferrer">puny</a>',
      '<a href="https://xn--bcher-kva.example" rel="noopener noreferrer">puny</a>',
    ],
    [
      '<a href="https://xn--ls8h-.example">bad puny</a>',
      '<a rel="noopener noreferrer">bad puny</a>',
      '<a rel="noopener noreferrer">bad puny</a>',
    ],
    [
      '<a href="https://xn--zz.example">undecodable</a>',
      '<a rel="noopener noreferrer">undecodable</a>',
      '<a rel="noopener noreferrer">undecodable</a>',
    ],
    [
      '<a href="https://xn--zzb">mark first</a>',
      '<a rel="noopener noreferrer">mark first</a>',
      '<a rel="noopener noreferrer">mark first</a>',
    ],
    [
      '<a href="https://aא.com">bidi</a>',
      '<a rel="noopener noreferrer">bidi</a>',
      '<a rel="noopener noreferrer">bidi</a>',
    ],
    [
      '<a href="https://א1.com">rtl ends with number</a>',
      '<a href="https://א1.com" rel="noopener noreferrer">rtl ends with number</a>',
      '<a href="https://א1.com" rel="noopener noreferrer">rtl ends with number</a>',
    ],
    [
      '<a href="https://שלום.com">rtl</a>',
      '<a href="https://שלום.com" rel="noopener noreferrer">rtl</a>',
      '<a href="https://שלום.com" rel="noopener noreferrer">rtl</a>',
    ],
    [
      '<a href="tel://@">tel</a><a href="mailto://@">mail</a><a href="tel://a@">user</a>',
      '<a href="tel://@" rel="noopener noreferrer">tel</a><a href="mailto://@" rel="noopener noreferrer">mail</a><a rel="noopener noreferrer">user</a>',
      '<a href="tel://@" rel="noopener noreferrer">tel</a><a href="mailto://@" rel="noopener noreferrer">mail</a><a rel="noopener noreferrer">user</a>',
    ],
    [
      '<a href="tel://h:1\\x">port</a><a href="https://h:65536/">big port</a>',
      '<a href="tel://h:1\\x" rel="noopener noreferrer">port</a><a rel="noopener noreferrer">big port</a>',
      '<a href="tel://h:1\\x" rel="noopener noreferrer">port</a><a rel="noopener noreferrer">big port</a>',
    ],
    [
      '<a href="http://1.2.3.256">ipv4</a><a href="http://0x7f.1">hex</a><a href="http://[::1]">v6</a><a href="http://[1::2::3]">bad v6</a>',
      '<a rel="noopener noreferrer">ipv4</a><a href="http://0x7f.1" rel="noopener noreferrer">hex</a><a href="http://[::1]" rel="noopener noreferrer">v6</a><a rel="noopener noreferrer">bad v6</a>',
      '<a rel="noopener noreferrer">ipv4</a><a href="http://0x7f.1" rel="noopener noreferrer">hex</a><a href="http://[::1]" rel="noopener noreferrer">v6</a><a rel="noopener noreferrer">bad v6</a>',
    ],
    [
      '<a href="http://exa mple.com">space</a><a href="http://%2569">pct</a><a href="http://a%0ab">nl</a>',
      '<a rel="noopener noreferrer">space</a><a rel="noopener noreferrer">pct</a><a rel="noopener noreferrer">nl</a>',
      '<a rel="noopener noreferrer">space</a><a rel="noopener noreferrer">pct</a><a rel="noopener noreferrer">nl</a>',
    ],
    [
      '<a href="http:">empty</a><a href="https:x">noslash</a><a href="https://@">at</a>',
      '<a rel="noopener noreferrer">empty</a><a href="https:x" rel="noopener noreferrer">noslash</a><a rel="noopener noreferrer">at</a>',
      '<a rel="noopener noreferrer">empty</a><a href="https:x" rel="noopener noreferrer">noslash</a><a rel="noopener noreferrer">at</a>',
    ],
    [
      '<a href="//proto.relative/x">rel</a><a href="?q">q</a><a href="#f">f</a><a href="">empty</a>',
      '<a href="//proto.relative/x" rel="noopener noreferrer">rel</a><a href="?q" rel="noopener noreferrer">q</a><a href="#f" rel="noopener noreferrer">f</a><a href="" rel="noopener noreferrer">empty</a>',
      '<a href="//proto.relative/x" rel="noopener noreferrer">rel</a><a href="?q" rel="noopener noreferrer">q</a><a href="#f" rel="noopener noreferrer">f</a><a href="" rel="noopener noreferrer">empty</a>',
    ],
  ])('%j', (input, cleaned, sanitized) => {
    expect(nh3Clean(input)).toBe(cleaned);
    expect(sanitize(input)).toBe(sanitized);
  });
});

describe('the edges', () => {
  it('is idempotent on its own output', () => {
    const once = sanitize('<p>a <a href="/x">b</a><b>c</b></p><p><br></p>');
    expect(sanitize(once)).toBe(once);
  });

  it('cleans nothing to nothing', () => {
    expect(sanitize('')).toBe('');
    expect(sanitize(null)).toBe('');
  });

  it('refuses a lone surrogate, as PyO3 does', () => {
    expect(() => nh3Clean('a\ud800b')).toThrow(/surrogates not allowed/);
  });

  it('counts the length in code points', () => {
    expect(tooLong('😀'.repeat(100_000))).toBe(false);
    expect(tooLong('😀'.repeat(100_001))).toBe(true);
  });

  it('survives nesting deeper than the call stack', () => {
    const deep = `${'<blockquote>'.repeat(20_000)}x`;
    expect(sanitize(deep)).toBe(`${deep}${'</blockquote>'.repeat(20_000)}`);
  });
});
