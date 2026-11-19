import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CheckIcon, ChevronDown, FolderIcon } from "./icons.js";
import { classes, plural } from "./model.js";
import { NO_PROJECT, projectLabel, type ProjectEntry } from "./projects.mjs";

export interface ProjectMenuProps {
  entries: ProjectEntry[];
  /** "" for all projects, NO_PROJECT, or the project's name. */
  project: string;
  onPick: (project: string) => void;
}

/**
 * The project selector, at the left of the top bar: All projects, each project found on the cards
 * (a `repo:` tag) with its open cards, and No project. The choice narrows the whole board: the
 * columns, their counts and the search. Arrow keys move, Enter picks, Esc closes.
 */
export function ProjectMenu({ entries, project, onPick }: ProjectMenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // A project in the address that no card has (yet): it is shown, with no card.
  const shown = entries.some((entry) => entry.name === project) ? entries : [...entries, { name: project, open: 0 }];

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent): void => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape, true);
    window.setTimeout(() => list.current?.querySelector<HTMLElement>("[aria-selected='true']")?.focus(), 0);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const rove = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...event.currentTarget.querySelectorAll<HTMLElement>("[role='option']")];
    const at = options.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : event.key === "ArrowDown" ? Math.min(options.length - 1, at + 1) : Math.max(0, at - 1);
    event.preventDefault();
    options[next]?.focus();
  };

  const pick = (name: string): void => {
    setOpen(false);
    onPick(name);
    button.current?.focus();
  };

  return (
    <div className="project-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={classes("project-button", project !== "" && "project-on")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Project: ${projectLabel(project)}. Choose the project the board shows`}
        onClick={() => setOpen(!open)}
        data-testid="project"
      >
        <FolderIcon size={15} />
        <span className="project-name">{projectLabel(project)}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="popover project-list" role="listbox" aria-label="Projects" ref={list} onKeyDown={rove} data-testid="project-list">
          <div className="popover-title">Show the cards of</div>
          {shown.map((entry) => {
            const selected = entry.name === project;
            return (
              <button
                key={entry.name || "all"}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={classes("project-option", selected && "on", entry.name === "" && "project-all", entry.name === NO_PROJECT && "project-none")}
                onClick={() => pick(entry.name)}
                title={`${plural(entry.open, "open card")}: not in the last column, not archived`}
                data-testid={`project-option-${entry.name === "" ? "all" : entry.name === NO_PROJECT ? "none" : entry.name}`}
              >
                <span className="project-check" aria-hidden="true">{selected ? <CheckIcon size={14} /> : null}</span>
                <span className="project-option-name">{projectLabel(entry.name)}</span>
                <span className="project-count" aria-label={plural(entry.open, "open card")}>
                  {entry.open}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
