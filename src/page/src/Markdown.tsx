import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";
import { mentionsIn, mentionTokens } from "../../core/mentions.js";
import type { Mention, ParticipantInfo } from "../../server/contract.js";
import { initialOf } from "./Mentions.js";
import { classes } from "./model.js";

/**
 * Markdown as the board renders it: marked (GitHub's dialect) turns it into HTML, DOMPurify
 * sanitizes that HTML (no script, no style, no event attribute, links only to the web, mail, the
 * editor and the page itself), and then the board's own links are added with the DOM's API:
 *
 * - a path or an evidence record the process found on this machine opens in VS Code
 *   (`vscode://file/…:line`); the process says which texts those are (`mentions`);
 * - a card id (`#42`) of a card on the board opens that card on top;
 * - a mention of a participant (`@robin`, given `participants`) is a chip with their name: exactly
 *   the mentions the core records as the text's `addressed` (code, links and an escaped `\@` stay text).
 *
 * Nothing in a card's text is ever inserted as HTML without passing the sanitizer.
 */
const markdown = new Marked({ gfm: true, breaks: false, async: false });

/** DOMPurify's own list of safe link targets, with the editor's scheme added. */
const ALLOWED_URI = /^(?:(?:https?|mailto|vscode):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

function sanitize(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "option", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "class", "id", "name"]
  });
}

/** A mention's text without the punctuation that ends a sentence around it (the process trims the same way). */
function trimMention(text: string): string {
  return text.trim().replace(/[.,;:!?)\]]+$/, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function editorLink(document: Document, mention: Mention, child: Node): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = mention.href;
  anchor.className = mention.kind === "evidence" ? "ref ref-evidence" : "ref ref-path";
  anchor.title = mention.kind === "evidence" ? "Open the evidence record in the editor" : `Open in the editor${mention.line ? ` at line ${mention.line}` : ""}`;
  anchor.append(child);
  return anchor;
}

function cardLink(document: Document, id: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = `?card=${encodeURIComponent(id)}`;
  anchor.dataset.card = id;
  anchor.className = "ref ref-card";
  anchor.title = `Open card #${id} on top`;
  anchor.textContent = `#${id}`;
  return anchor;
}

function linkify(root: DocumentFragment, mentions: Record<string, Mention>, cards: ReadonlySet<string>): void {
  const document = root.ownerDocument;

  for (const anchor of [...root.querySelectorAll("a")]) {
    const href = anchor.getAttribute("href") ?? "";
    const mention = mentions[trimMention(href)];
    const card = /^#([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(href);
    if (mention) {
      anchor.setAttribute("href", mention.href);
      anchor.className = mention.kind === "evidence" ? "ref ref-evidence" : "ref ref-path";
      anchor.title = "Open in the editor";
    } else if (card && cards.has(card[1]!)) {
      anchor.setAttribute("href", `?card=${card[1]}`);
      anchor.dataset.card = card[1]!;
      anchor.className = "ref ref-card";
    } else if (/^https?:/i.test(href)) {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    } else if (!/^(mailto|vscode):/i.test(href)) {
      // A relative link that names nothing on this machine: its words stay, as text.
      anchor.replaceWith(...anchor.childNodes);
    }
  }

  for (const code of [...root.querySelectorAll("code")]) {
    if (code.closest("pre, a")) continue;
    const mention = mentions[trimMention(code.textContent ?? "")];
    if (!mention) continue;
    const placeholder = document.createComment("");
    code.replaceWith(placeholder);
    placeholder.replaceWith(editorLink(document, mention, code));
  }

  // Group 1: a text the process found on this machine (a group that never matches when there is
  // none, so that group 2 is always the card id). Group 2: a card id, `#42` or a word id
  // (`#robin-12`), never the dot that ends a sentence.
  const keys = Object.keys(mentions).sort((left, right) => right.length - left.length);
  const named = keys.length > 0 ? keys.map(escapeRegExp).join("|") : "(?!)";
  const pattern = new RegExp(`(?<![\\w./:@-])(${named})(?![\\w/])|(?<![\\w&#/])#([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?![\\w-])`, "g");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => ((node.parentElement?.closest("a, code, pre") ?? null) === null ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const text of texts) {
    const value = text.data;
    pattern.lastIndex = 0;
    const parts: Node[] = [];
    let last = 0;
    for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
      const mention = match[1] !== undefined ? mentions[match[1]] : undefined;
      const card = match[2] !== undefined && cards.has(match[2]) ? match[2] : undefined;
      if (!mention && !card) continue;
      if (match.index > last) parts.push(document.createTextNode(value.slice(last, match.index)));
      parts.push(mention ? editorLink(document, mention, document.createTextNode(match[0])) : cardLink(document, card!));
      last = match.index + match[0].length;
    }
    if (parts.length === 0) continue;
    if (last < value.length) parts.push(document.createTextNode(value.slice(last)));
    text.replaceWith(...parts);
  }
}

/** A participant's mention, as a chip: their mark (the person's round one, an agent's dashed square) and their name. */
function mentionChip(document: Document, participant: ParticipantInfo, you: boolean): HTMLElement {
  const chip = document.createElement("span");
  chip.className = classes("mention", `mention-${participant.kind}`, you && "mention-you");
  chip.dataset.mention = participant.id;
  chip.title = `${participant.name}${you ? " (you)" : ""}, ${participant.kind === "agent" ? "an agent" : "a person"} · @${participant.id}`;
  const mark = document.createElement("span");
  mark.className = `mention-avatar avatar-${participant.kind}`;
  mark.dataset.initial = initialOf(participant);
  mark.setAttribute("aria-hidden", "true");
  chip.append(mark, document.createTextNode(participant.name));
  return chip;
}

/**
 * Turns the mentions in the text outside links and code into chips: only those of `addressed`, the
 * ids the core reads in the markdown source (so that what shows as a mention is what was recorded).
 */
function chipMentions(root: DocumentFragment, participants: ParticipantInfo[], addressed: ReadonlySet<string>, viewer: string | undefined): void {
  if (addressed.size === 0) return;
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => ((node.parentElement?.closest("a, code, pre, .mention") ?? null) === null ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const text of texts) {
    const value = text.data;
    const tokens = mentionTokens(value, participants).filter((token) => addressed.has(token.participant.id));
    if (tokens.length === 0) continue;
    const parts: Node[] = [];
    let last = 0;
    for (const token of tokens) {
      if (token.index > last) parts.push(document.createTextNode(value.slice(last, token.index)));
      parts.push(mentionChip(document, token.participant, token.participant.id === viewer));
      last = token.index + token.text.length;
    }
    if (last < value.length) parts.push(document.createTextNode(value.slice(last)));
    text.replaceWith(...parts);
  }
}

export interface MarkdownProps {
  text: string;
  mentions?: Record<string, Mention>;
  /** The ids of the board's cards: `#42` links only a card that is there. */
  cards: ReadonlySet<string>;
  /** The board's participants: a mention of one is a chip (in a comment or a description, where it addresses them). */
  participants?: ParticipantInfo[];
  /** The page's person: their own mention is marked as theirs. */
  viewer?: string;
  onOpenCard?: (id: string) => void;
  className?: string;
}

const NO_MENTIONS: Record<string, Mention> = {};
const NO_PARTICIPANTS: ParticipantInfo[] = [];

export function Markdown({ text, mentions = NO_MENTIONS, cards, participants = NO_PARTICIPANTS, viewer, onOpenCard, className }: MarkdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => markdown.parse(text, { async: false }), [text]);
  const addressed = useMemo(() => new Set(mentionsIn(text, participants)), [text, participants]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const fragment = sanitize(html);
    linkify(fragment, mentions, cards);
    chipMentions(fragment, participants, addressed, viewer);
    node.replaceChildren(fragment);
  }, [html, mentions, cards, participants, addressed, viewer]);
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const anchor = (event.target as HTMLElement).closest("a");
    const card = anchor?.getAttribute("data-card");
    if (!card || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpenCard?.(card);
  };
  return <div ref={ref} className={classes("md", className)} onClick={onClick} />;
}
