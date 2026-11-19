import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ThemeChoicesInfo } from "../../server/contract.js";
import { SYSTEM_THEME, THEME_BACKGROUND, THEMES, themeOf, type ThemeGroup, type ThemeInfo } from "../../core/themes.js";
import { BACKGROUNDS } from "./appearance.mjs";
import { CheckIcon, PaletteIcon } from "./icons.js";
import { classes } from "./model.js";
import { projectLabel } from "./projects.mjs";

export interface ThemeMenuProps {
  /** The choices that apply now (the project's own, then the default). */
  choices: { theme: string; lightTheme: string; darkTheme: string; background: string };
  /** The theme the page shows (System resolved). */
  shown: ThemeInfo;
  /** "" for all projects, "(none)", or the project's name: whose choices a pick saves. */
  project: string;
  /** The project keeps choices of its own (it can go back to the default). */
  own: boolean;
  onPick: (patch: ThemeChoicesInfo) => void;
  onUseDefault: () => void;
}

const GROUPS: Array<[ThemeGroup, string]> = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["contrast", "High contrast"]
];

/** A theme in small: its ground, a card of its surface with a line of its ink and a line of its accent, a dot of its accent. Drawn in the theme's own tokens. */
function Swatch({ theme }: { theme: string }) {
  return (
    <span className="theme-swatch" data-theme-scope={theme} aria-hidden="true">
      <span className="swatch-card">
        <span className="swatch-line" />
        <span className="swatch-line swatch-line-short" />
      </span>
      <span className="swatch-accent" />
    </span>
  );
}

/**
 * The theme and the board's background (the top bar's palette): the ten themes grouped Light, Dark
 * and High contrast, each shown with a swatch and its name in its own face, and System, which follows
 * the computer between the light and the dark theme picked last. A pick applies at once and is kept
 * for the project shown ("for all projects" when none is). Arrow keys move through the list, Enter
 * picks, Esc closes.
 */
export function ThemeMenu({ choices, shown, project, own, onPick, onUseDefault }: ThemeMenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState(choices.background !== THEME_BACKGROUND ? choices.background : "#808080");
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (choices.background !== THEME_BACKGROUND) setCustom(choices.background);
  }, [choices.background]);

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
    // The list opens on the theme in use.
    window.setTimeout(() => list.current?.querySelector<HTMLElement>("[role='radio'][aria-checked='true']")?.focus(), 0);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  /** Up and down (and left and right) move through a group of radios; Home and End go to its ends. */
  const rove = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const keys = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const radios = [...event.currentTarget.querySelectorAll<HTMLElement>("[role='radio']")];
    const at = radios.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? Math.min(radios.length - 1, at + 1) : Math.max(0, at - 1);
    event.preventDefault();
    radios[next]?.focus();
  };

  const pickTheme = (theme: ThemeInfo): void => onPick({ theme: theme.id, ...(theme.mode === "light" ? { lightTheme: theme.id } : { darkTheme: theme.id }) });
  const palette = BACKGROUNDS[shown.mode];
  const background = choices.background;
  const custom12 = background !== THEME_BACKGROUND && !palette.some((colour) => colour.hex === background);
  const forWhom = project === "" || project === "(none)" ? "all projects" : projectLabel(project);
  const light = themeOf(choices.lightTheme);
  const dark = themeOf(choices.darkTheme);
  const isSystem = choices.theme === SYSTEM_THEME;
  const label = isSystem ? `System (${shown.name} now)` : shown.name;

  return (
    <div className="theme-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="theme-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Theme: ${label}. Change the theme or the board's background`}
        title={`Theme: ${label}`}
        onClick={() => setOpen(!open)}
        data-testid="theme"
      >
        <PaletteIcon size={16} />
        <span className="theme-button-name">{shown.name}</span>
      </button>
      {open ? (
        <div className="popover theme-menu" role="dialog" aria-label="Theme and board background" data-testid="theme-menu">
          <div className="theme-menu-head">
            <span className="popover-title">Theme</span>
            <span className="theme-for" data-testid="theme-for">
              for {forWhom}
            </span>
            {own ? (
              <button type="button" className="text-button theme-default" onClick={onUseDefault} data-testid="theme-use-default" title="Forget this project's own theme and background: it shows the default again">
                Use the default
              </button>
            ) : null}
          </div>
          <div className="theme-list" role="radiogroup" aria-label="Theme" ref={list} onKeyDown={rove}>
            {GROUPS.map(([group, words]) => (
              <div key={group} className="theme-group" role="presentation">
                <div className="theme-group-name" aria-hidden="true">
                  {words}
                </div>
                {THEMES.filter((theme) => theme.group === group).map((theme) => {
                  const checked = !isSystem && choices.theme === theme.id;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      tabIndex={checked ? 0 : -1}
                      className={classes("theme-option", checked && "on")}
                      onClick={() => pickTheme(theme)}
                      title={`${theme.name}: ${theme.about}; reads in ${theme.font}`}
                      data-theme-option={theme.id}
                    >
                      <Swatch theme={theme.id} />
                      <span className="theme-name" data-theme-scope={theme.id}>
                        {theme.name}
                      </span>
                      {checked ? <CheckIcon size={15} className="theme-check" label="in use" /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="theme-group" role="presentation">
              <button
                type="button"
                role="radio"
                aria-checked={isSystem}
                tabIndex={isSystem ? 0 : -1}
                className={classes("theme-option", "theme-system", isSystem && "on")}
                onClick={() => onPick({ theme: SYSTEM_THEME })}
                title="Follows the computer: the light theme by day, the dark theme by night, the ones you picked last"
                data-theme-option="system"
              >
                <span className="theme-swatch-pair" aria-hidden="true">
                  <Swatch theme={light?.id ?? "paper"} />
                  <Swatch theme={dark?.id ?? "navy"} />
                </span>
                <span className="theme-name">
                  System
                  <span className="theme-note">
                    {light?.name ?? "Paper"} or {dark?.name ?? "Navy"}, as the computer is set
                  </span>
                </span>
                {isSystem ? <CheckIcon size={15} className="theme-check" label="in use" /> : null}
              </button>
            </div>
          </div>
          <div className="theme-menu-section">
            <div className="popover-title">Board background</div>
            <div className="background-list" role="radiogroup" aria-label="Board background" onKeyDown={rove}>
              <button
                type="button"
                role="radio"
                aria-checked={background === THEME_BACKGROUND}
                tabIndex={background === THEME_BACKGROUND ? 0 : -1}
                className={classes("background-theme", background === THEME_BACKGROUND && "on")}
                onClick={() => onPick({ background: THEME_BACKGROUND })}
                data-background="theme"
              >
                {background === THEME_BACKGROUND ? <CheckIcon size={13} /> : null}
                The theme's own
              </button>
              {palette.map((colour) => {
                const checked = background === colour.hex;
                return (
                  <button
                    key={colour.hex}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={colour.name}
                    title={`${colour.name} (${colour.hex})`}
                    tabIndex={checked ? 0 : -1}
                    className={classes("background-swatch", checked && "on")}
                    style={{ "--swatch": colour.hex } as CSSProperties}
                    onClick={() => onPick({ background: colour.hex })}
                    data-background={colour.hex}
                  >
                    {checked ? <CheckIcon size={12} /> : null}
                  </button>
                );
              })}
            </div>
            <label className={classes("background-custom", custom12 && "on")} title="Any colour: the text on the board switches to stay readable">
              <input
                type="color"
                value={custom}
                onChange={(event) => {
                  const value = event.target.value.toLowerCase();
                  setCustom(value);
                  window.clearTimeout(saveTimer.current);
                  saveTimer.current = window.setTimeout(() => onPick({ background: value }), 300);
                }}
                aria-label="A colour of your own for the board's background"
                data-testid="background-custom"
              />
              {custom12 ? <CheckIcon size={13} /> : null}
              A colour of your own
            </label>
            <p className="theme-saving" data-testid="theme-saving">
              Kept for {forWhom}
              {project !== "" && project !== "(none)" ? (own ? ": its own theme" : ": the default until you pick one") : ""}.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
