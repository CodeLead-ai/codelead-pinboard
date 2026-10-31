import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { BoardPayload } from "../../server/contract.js";
import { ChevronDown, CloseIcon, SearchIcon } from "./icons.js";
import { classes, EMPTY_FILTER, isFiltering, repositoriesOf, tagGroups, type Filter } from "./model.js";

export interface FilterBarProps {
  board: BoardPayload;
  filter: Filter;
  onChange: (next: Filter) => void;
  matching: number;
  total: number;
  searchRef: RefObject<HTMLInputElement | null>;
}

/**
 * The filter (spec 6.1): column, type, tags (the reserved namespaces grouped), repository and free
 * text, stacked; "fade" dims what does not match, "hide" removes it; the columns never move. All of
 * it is in the URL's query.
 */
export function FilterBar({ board, filter, onChange, matching, total, searchRef }: FilterBarProps) {
  const repositories = useMemo(() => repositoriesOf(board.cards), [board.cards]);
  const groups = useMemo(() => tagGroups(board.cards, board.tagNamespaces), [board.cards, board.tagNamespaces]);
  const set = (part: Partial<Filter>): void => onChange({ ...filter, ...part });
  const filtering = isFiltering(filter);

  return (
    <div className="filterbar" role="search">
      <label className="search">
        <SearchIcon size={15} />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search the cards, or #42"
          value={filter.q}
          onChange={(event) => set({ q: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          aria-label="Search the cards"
          data-testid="search"
        />
        <kbd className="search-key" aria-hidden="true">
          /
        </kbd>
      </label>

      <Select label="Column" value={filter.column} onChange={(column) => set({ column })} options={board.columns.map((column) => [column.id, column.name])} anyWords="Any column" testId="filter-column" />
      <Select label="Type" value={filter.type} onChange={(type) => set({ type })} options={board.types.map((type) => [type, type])} anyWords="Any type" testId="filter-type" />
      <TagPicker groups={groups} chosen={filter.tags} onChange={(tags) => set({ tags })} />
      {repositories.length > 0 ? (
        <Select label="Repository" value={filter.repo} onChange={(repo) => set({ repo })} options={repositories.map((name) => [name, name])} anyWords="Any repository" testId="filter-repo" />
      ) : null}

      <label className="check" title="Archived cards leave the board; they stay in their files and stay searchable.">
        <input type="checkbox" checked={filter.archived} onChange={(event) => set({ archived: event.target.checked })} data-testid="filter-archived" />
        archived
      </label>

      <div className="segmented" role="group" aria-label="Cards that do not match">
        {(["fade", "hide"] as const).map((mode) => (
          <button key={mode} type="button" aria-pressed={filter.show === mode} className={classes(filter.show === mode && "on")} onClick={() => set({ show: mode })} data-testid={`show-${mode}`}>
            {mode}
          </button>
        ))}
      </div>

      <span className="filter-sum" aria-live="polite">
        {filtering ? (
          <>
            <b>{matching}</b> of {total} match{" "}
            <button type="button" className="text-button" onClick={() => onChange({ ...EMPTY_FILTER, show: filter.show, archived: filter.archived })} data-testid="clear-filter">
              Clear
            </button>
          </>
        ) : (
          <>
            <b>{total}</b> cards
          </>
        )}
      </span>
    </div>
  );
}

function Select({ label, value, onChange, options, anyWords, testId }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]>; anyWords: string; testId: string }) {
  return (
    <label className={classes("select", value !== "" && "select-on")}>
      <span className="select-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} data-testid={testId}>
        <option value="">{anyWords}</option>
        {options.map(([id, words]) => (
          <option key={id} value={id}>
            {words}
          </option>
        ))}
      </select>
      <ChevronDown size={13} className="select-chevron" />
    </label>
  );
}

function TagPicker({ groups, chosen, onChange }: { groups: ReturnType<typeof tagGroups>; chosen: string[]; onChange: (tags: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent): void => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const toggle = (tag: string): void => onChange(chosen.includes(tag) ? chosen.filter((entry) => entry !== tag) : [...chosen, tag]);
  return (
    <div className="tagpicker" ref={wrap}>
      <button type="button" className={classes("select", "select-button", chosen.length > 0 && "select-on")} aria-expanded={open} onClick={() => setOpen(!open)} data-testid="filter-tags">
        <span className="select-label">Tags</span>
        <span className="select-value">{chosen.length === 0 ? "Any tag" : chosen.length === 1 ? chosen[0] : `${chosen.length} tags`}</span>
        <ChevronDown size={13} className="select-chevron" />
      </button>
      {chosen.length > 0 ? (
        <span className="chosen-tags">
          {chosen.map((tag) => (
            <button key={tag} type="button" className="chip chip-chosen" onClick={() => toggle(tag)} aria-label={`Stop filtering by ${tag}`}>
              {tag}
              <CloseIcon size={11} />
            </button>
          ))}
        </span>
      ) : null}
      {open ? (
        <div className="popover tag-list" role="listbox" aria-multiselectable="true" aria-label="Tags">
          {groups.length === 0 ? <p className="popover-empty">No card has a tag yet.</p> : null}
          {groups.map((group) => (
            <div key={group.name || "plain"} className="tag-group">
              <div className="tag-group-name">{group.name === "" ? "Tags" : `${group.name}:`}{group.reserved ? <span className="reserved"> reserved</span> : null}</div>
              {group.tags.map((tag) => (
                <label key={tag} className="tag-option" role="option" aria-selected={chosen.includes(tag)}>
                  <input type="checkbox" checked={chosen.includes(tag)} onChange={() => toggle(tag)} />
                  <span>{group.name === "" ? tag : tag.slice(group.name.length + 1)}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
