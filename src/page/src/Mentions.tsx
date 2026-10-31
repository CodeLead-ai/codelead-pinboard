import { useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { mentionAt, mentionCandidate } from "../../core/mentions.js";
import type { ParticipantInfo } from "../../server/contract.js";
import { classes } from "./model.js";

/**
 * Mentions in the page (the core's rule, shared: src/board/core/mentions.ts). Typing `@` in the
 * comment box or a description opens a small list of the board's participants, the others first
 * and the person last; it narrows as the person types, the arrows choose, Enter or a click writes
 * `@<id> `, Esc closes it. Nothing is written to the board until the text is sent: the event's
 * `addressed` is worked out by the core from the text, as for every other writer.
 */

/** A participant's mark, as the thread draws it: the person's round one, an agent's dashed square, with the initial. */
export function ParticipantMark({ participant }: { participant: ParticipantInfo }) {
  return <span className={`mention-avatar avatar-${participant.kind}`} data-initial={initialOf(participant)} aria-hidden="true" />;
}

export function initialOf(participant: ParticipantInfo): string {
  return participant.name.trim().charAt(0).toUpperCase() || participant.id.charAt(0).toUpperCase();
}

/** The textarea's handlers the picker wraps. */
interface OwnHandlers {
  onKeyDown?: ((event: KeyboardEvent<HTMLTextAreaElement>) => void) | undefined;
  onBlur?: ((event: FocusEvent<HTMLTextAreaElement>) => void) | undefined;
  onSelect?: ((event: SyntheticEvent<HTMLTextAreaElement>) => void) | undefined;
}

interface Typing {
  start: number;
  end: number;
  query: string;
}

export interface MentionPicker {
  /** The textarea's props: its own handlers wrapped (the list takes the arrows, Enter and Esc while open) and the list's ARIA. */
  bind: (own: OwnHandlers) => OwnHandlers & { "aria-autocomplete"?: "list"; "aria-controls"?: string; "aria-activedescendant"?: string };
  /** Called by the textarea's onChange with its new text and caret. */
  changed: (text: string, caret: number) => void;
  /** The list while it is open, to render beside the textarea inside a `.mention-host`. */
  list: ReactNode;
}

/** How wide the list is at most (CSS keeps it inside a narrow box). */
const LIST_WIDTH = 260;

/** The styles that decide where a textarea's text wraps: copied onto the measuring copy. */
const MEASURED = [
  "box-sizing",
  "width",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-style",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "text-indent",
  "tab-size"
];

/** Where the list opens: under the line of the `@`, at its left, in the coordinates of the textarea's `.mention-host`. */
function placeOf(area: HTMLTextAreaElement, position: number): { top: number; left: number } {
  const style = getComputedStyle(area);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 20;
  const below = { top: area.offsetTop + area.offsetHeight + 4, left: area.offsetLeft };
  try {
    const copy = document.createElement("div");
    for (const name of MEASURED) copy.style.setProperty(name, style.getPropertyValue(name));
    Object.assign(copy.style, { position: "absolute", top: "0", left: "-10000px", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", height: "auto", overflow: "hidden" });
    copy.textContent = area.value.slice(0, position);
    const marker = document.createElement("span");
    marker.textContent = "@";
    copy.append(marker);
    document.body.append(copy);
    const top = area.offsetTop + (parseFloat(style.borderTopWidth) || 0) + marker.offsetTop - area.scrollTop + lineHeight + 4;
    const left = area.offsetLeft + (parseFloat(style.borderLeftWidth) || 0) + marker.offsetLeft - area.scrollLeft;
    copy.remove();
    const host = area.parentElement;
    const room = Math.max(0, (host?.clientWidth ?? LIST_WIDTH) - LIST_WIDTH);
    // Never below the textarea's own bottom edge, never out of its box sideways.
    return { top: Math.min(top, below.top), left: Math.max(0, Math.min(left, room)) };
  } catch {
    return below;
  }
}

/** The participants in the list's order: the others first, the person who writes last. */
function inOrder(participants: ParticipantInfo[], viewer: string | undefined): ParticipantInfo[] {
  return [...participants.filter((participant) => participant.id !== viewer), ...participants.filter((participant) => participant.id === viewer)];
}

export function useMentionPicker({
  textarea,
  value,
  onChange,
  participants,
  viewer
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  /** The board's participants; none: no list (a field where a mention addresses no one). */
  participants: ParticipantInfo[] | undefined;
  viewer?: string | undefined;
}): MentionPicker {
  const listId = useId();
  const [typing, setTyping] = useState<Typing | null>(null);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  /** The `@` the person closed the list on with Esc: it stays closed until another `@`. */
  const dismissed = useRef<number | null>(null);
  /** Where the caret goes once a chosen mention is in the text. */
  const caret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const area = textarea.current;
    if (caret.current === null || !area) return;
    area.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value, textarea]);

  // The text replaced from outside (a comment sent with ⌘↵ empties the box): a list open on an `@` that is gone closes.
  useLayoutEffect(() => {
    if (typing !== null && (value[typing.start] !== "@" || typing.end > value.length)) {
      setTyping(null);
      setActive(0);
    }
  }, [value, typing]);

  const options = typing && participants ? inOrder(participants, viewer).filter((participant) => mentionCandidate(typing.query, participant)) : [];
  const open = typing !== null && options.length > 0;

  const close = (): void => {
    setTyping(null);
    setActive(0);
  };

  /** Reads the mention at the caret; `opening` false: only follows or closes a list that is open. */
  const follow = (text: string, at: number, opening: boolean): void => {
    if (!participants) return;
    const found = mentionAt(text, at);
    if (!found) {
      dismissed.current = null;
      close();
      return;
    }
    if (found.start === dismissed.current || (!opening && typing === null)) {
      close();
      return;
    }
    if (!participants.some((participant) => mentionCandidate(found.query, participant))) {
      close();
      return;
    }
    if (typing === null || typing.start !== found.start || typing.query !== found.query) setActive(0);
    setTyping(found);
    const area = textarea.current;
    if (area && (typing === null || typing.start !== found.start)) setPlace(placeOf(area, found.start));
  };

  const pick = (participant: ParticipantInfo): void => {
    if (!typing) return;
    const after = value.slice(typing.end);
    const written = `@${participant.id}`;
    // `@<id> `: a space after it, unless one is there already; the caret goes after the space.
    const next = `${value.slice(0, typing.start)}${written}${after.startsWith(" ") ? "" : " "}${after}`;
    caret.current = typing.start + written.length + 1;
    dismissed.current = null;
    close();
    onChange(next);
  };

  const bind: MentionPicker["bind"] = (own) => {
    if (!participants) return {};
    return {
      onKeyDown: (event) => {
        if (open && !event.nativeEvent.isComposing) {
          const handled = ((): boolean => {
            switch (event.key) {
              case "ArrowDown":
                setActive((index) => (index + 1) % options.length);
                return true;
              case "ArrowUp":
                setActive((index) => (index - 1 + options.length) % options.length);
                return true;
              case "Enter":
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
                pick(options[Math.min(active, options.length - 1)]!);
                return true;
              case "Escape":
                // Esc closes the list, not the editor or the card.
                dismissed.current = typing!.start;
                close();
                return true;
              default:
                return false;
            }
          })();
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        own.onKeyDown?.(event);
      },
      onBlur: (event) => {
        close();
        own.onBlur?.(event);
      },
      onSelect: (event) => {
        if (typing !== null) follow(event.currentTarget.value, event.currentTarget.selectionStart, false);
        own.onSelect?.(event);
      },
      "aria-autocomplete": "list",
      ...(open ? { "aria-controls": listId, "aria-activedescendant": `${listId}-${Math.min(active, options.length - 1)}` } : {})
    };
  };

  const list = open ? (
    <div className="popover mention-list" role="listbox" id={listId} aria-label="Mention a participant" style={{ top: place.top, left: place.left }} data-testid="mention-list">
      {options.map((participant, index) => (
        <button
          key={participant.id}
          id={`${listId}-${index}`}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          className={classes("mention-option", index === active && "on")}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(index)}
          onClick={() => pick(participant)}
          data-mention={participant.id}
        >
          <ParticipantMark participant={participant} />
          <span className="mention-name">{participant.name}</span>
          <span className="mention-id">@{participant.id}</span>
        </button>
      ))}
    </div>
  ) : null;

  return { bind, changed: (text, at) => follow(text, at, true), list };
}
