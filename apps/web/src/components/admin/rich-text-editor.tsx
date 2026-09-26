"use client";

import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
  Unlink,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { cn } from "@/lib/cn";

/**
 * Rich text for site pages (About, policies, the shop's own pages).
 *
 * TipTap (ProseMirror) with only the formatting the API keeps: headings 2-3,
 * bold, italic, underline, strike, lists, quotes, dividers and links. Code and
 * code blocks are switched off because `content.rich_text` would strip them;
 * offering a button whose result vanishes on save would be a lie. The server
 * sanitises every body regardless -- this editor is a convenience, not the
 * control (ADR-0012).
 *
 * The toolbar follows the WAI-ARIA toolbar pattern: one tab stop, arrow keys
 * (and Home/End) between buttons, `aria-pressed` on the toggles. Every command
 * also has TipTap's keyboard shortcut (Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+Z...).
 *
 * The editing surface uses the storefront's own `.rich-text` styles, so what a
 * manager sees here is what a shopper reads.
 */

/** Same shapes the API accepts in a page body: site paths, http(s), mailto, tel. */
function isAllowedHref(href: string): boolean {
  return /^(\/(?!\/)|https?:\/\/|mailto:|tel:)/i.test(href) && !/[\s\\]/.test(href);
}

/** Module-level so the array keeps one identity for the life of the page. */
const EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [2, 3] },
    code: false,
    codeBlock: false,
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: "https",
      // The API adds rel itself and strips target; keep the editor's markup
      // the same shape as what it stores.
      HTMLAttributes: { target: null, rel: "noopener noreferrer" },
      isAllowedUri: (url) => isAllowedHref(url),
    },
  }),
];

/** Toolbar state before the editor reports any (see `useEditorState` below). */
const NOTHING_ACTIVE = {
  h2: false,
  h3: false,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  bullet: false,
  ordered: false,
  quote: false,
  link: false,
  canUndo: false,
  canRedo: false,
};

interface ToolbarButton {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
  pressed?: boolean;
  disabled?: boolean;
}

export function RichTextEditor({
  id,
  labelledBy,
  initialHtml,
  onChange,
  disabled = false,
}: {
  id: string;
  labelledBy: string;
  initialHtml: string;
  /** Called on every edit with the editor's HTML (not called for the initial content). */
  onChange: (html: string) => void;
  disabled?: boolean;
}) {
  // Stable across renders: TipTap compares options by identity on every
  // render and re-applies them to the editor when anything differs.
  const editorProps = useMemo(
    () => ({
      attributes: {
        id,
        role: "textbox",
        "aria-multiline": "true",
        "aria-labelledby": labelledBy,
        class: "rich-text min-h-[20rem] px-4 py-3 focus:outline-none",
      },
    }),
    [id, labelledBy],
  );

  const editor = useEditor({
    // Rendered on the client only: the server has no DOM for ProseMirror, and
    // rendering it there would mismatch on hydration.
    immediatelyRender: false,
    editable: !disabled,
    extensions: EXTENSIONS,
    content: initialHtml,
    editorProps,
    onUpdate: ({ editor: current }) => onChange(current.getHTML()),
  });

  // `useEditorState` caches its snapshot until the editor's first transaction,
  // so it can still answer `null` after the editor exists. Never wait on it:
  // the editor only mounts (and so only ever has a transaction) once
  // `EditorContent` renders. Gating the render on this state deadlocked.
  const selected = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current
        ? {
            h2: current.isActive("heading", { level: 2 }),
            h3: current.isActive("heading", { level: 3 }),
            bold: current.isActive("bold"),
            italic: current.isActive("italic"),
            underline: current.isActive("underline"),
            strike: current.isActive("strike"),
            bullet: current.isActive("bulletList"),
            ordered: current.isActive("orderedList"),
            quote: current.isActive("blockquote"),
            link: current.isActive("link"),
            canUndo: current.can().undo(),
            canRedo: current.can().redo(),
          }
        : null,
  });

  const state = selected ?? NOTHING_ACTIVE;

  const toolbarRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  if (!editor) {
    // Same height as the editor, so the page does not jump when it mounts.
    return <div className="skeleton h-[23rem] rounded-md" aria-hidden />;
  }

  const chain = () => editor.chain().focus();

  function editLink() {
    if (!editor) return;
    const current = (editor.getAttributes("link").href as string | undefined) ?? "";
    const href = window.prompt(
      "Link address — a page on this site such as /contact, or https://…",
      current,
    );
    if (href === null) return;
    const trimmed = href.trim();
    if (!trimmed) {
      chain().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (!isAllowedHref(trimmed)) {
      window.alert("Use a site address such as /contact, or one starting https://, mailto: or tel:.");
      return;
    }
    chain().extendMarkRange("link").setLink({ href: trimmed }).run();
  }

  const groups: ToolbarButton[][] = [
    [
      { label: "Heading", icon: Heading2, pressed: state.h2, run: () => chain().toggleHeading({ level: 2 }).run() },
      { label: "Subheading", icon: Heading3, pressed: state.h3, run: () => chain().toggleHeading({ level: 3 }).run() },
    ],
    [
      { label: "Bold", icon: Bold, pressed: state.bold, run: () => chain().toggleBold().run() },
      { label: "Italic", icon: Italic, pressed: state.italic, run: () => chain().toggleItalic().run() },
      { label: "Underline", icon: Underline, pressed: state.underline, run: () => chain().toggleUnderline().run() },
      { label: "Strikethrough", icon: Strikethrough, pressed: state.strike, run: () => chain().toggleStrike().run() },
    ],
    [
      { label: "Bulleted list", icon: List, pressed: state.bullet, run: () => chain().toggleBulletList().run() },
      { label: "Numbered list", icon: ListOrdered, pressed: state.ordered, run: () => chain().toggleOrderedList().run() },
      { label: "Quote", icon: Quote, pressed: state.quote, run: () => chain().toggleBlockquote().run() },
      { label: "Divider", icon: Minus, run: () => chain().setHorizontalRule().run() },
    ],
    [
      { label: state.link ? "Edit link" : "Add link", icon: LinkIcon, pressed: state.link, run: editLink },
      { label: "Remove link", icon: Unlink, disabled: !state.link, run: () => chain().extendMarkRange("link").unsetLink().run() },
    ],
    [
      { label: "Undo", icon: Undo2, disabled: !state.canUndo, run: () => chain().undo().run() },
      { label: "Redo", icon: Redo2, disabled: !state.canRedo, run: () => chain().redo().run() },
    ],
  ];
  const flat = groups.flat();
  const enabled = flat.flatMap((button, position) => (button.disabled ? [] : [position]));
  // The one tab stop must be a button that can take focus.
  const tabStop = enabled.includes(focusIndex) ? focusIndex : (enabled[0] ?? 0);

  function onToolbarKey(event: React.KeyboardEvent) {
    if (!enabled.length) return;
    const at = Math.max(enabled.indexOf(tabStop), 0);
    const last = enabled.length - 1;
    const step: Record<string, number> = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    };
    if (!(event.key in step)) return;
    event.preventDefault();
    const next = enabled[step[event.key]];
    setFocusIndex(next);
    toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }

  let index = -1;
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-neutral-300 bg-white",
        "focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-[var(--ring)]",
        disabled && "bg-neutral-50",
      )}
    >
      {!disabled && (
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label="Formatting"
          aria-controls={id}
          onKeyDown={onToolbarKey}
          className="flex flex-wrap items-center gap-1 border-b border-border bg-neutral-50 p-1.5"
        >
          {groups.map((group, groupIndex) => (
            <div key={groupIndex} className="flex items-center gap-0.5">
              {groupIndex > 0 && <span className="mx-1 h-6 w-px bg-neutral-300" aria-hidden />}
              {group.map((button) => {
                index += 1;
                const position = index;
                const Icon = button.icon;
                return (
                  <button
                    key={button.label}
                    type="button"
                    tabIndex={position === tabStop ? 0 : -1}
                    onFocus={() => setFocusIndex(position)}
                    onClick={button.run}
                    // Keep the text selection: a mousedown would otherwise
                    // move focus off the editor before the command runs.
                    onMouseDown={(event) => event.preventDefault()}
                    disabled={button.disabled}
                    aria-pressed={button.pressed === undefined ? undefined : button.pressed}
                    aria-label={button.label}
                    title={button.label}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-md text-neutral-700 transition-colors duration-fast",
                      "hover:bg-neutral-200 disabled:pointer-events-none disabled:opacity-40",
                      "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]",
                      button.pressed && "bg-neutral-900 text-white hover:bg-neutral-800",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
