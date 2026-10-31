import type { ReactNode, SVGProps } from "react";
import { toneOf } from "./model.js";

/**
 * The page's marks, drawn as SVG in the current colour: the six type glyphs of spec 6.1
 * (? question, ◆ decision, ▣ task, ✦ idea, ↩ review, ≡ note), the tile's marks (⚑ waits on you,
 * ⚙ an agent is working, the comment count), and the controls. No emoji, no icon font.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number; label?: string };

function Svg({ size = 16, label, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...rest}
    >
      {label ? <title>{label}</title> : null}
      {children}
    </svg>
  );
}

export function TypeGlyph({ type, size = 15, label }: { type: string; size?: number; label?: string }) {
  switch (type) {
    case "question":
      return (
        <Svg size={size} label={label}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M6.1 6.2a1.95 1.95 0 1 1 2.8 1.75c-.55.27-.9.7-.9 1.3v.35" />
          <circle cx="8" cy="11.6" r=".55" fill="currentColor" stroke="none" />
        </Svg>
      );
    case "decision":
      return (
        <Svg size={size} label={label}>
          <path d="M8 1.7 14.3 8 8 14.3 1.7 8Z" fill="currentColor" stroke="none" />
        </Svg>
      );
    case "task":
      return (
        <Svg size={size} label={label}>
          <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" />
          <rect x="5.3" y="5.3" width="5.4" height="5.4" rx="1" fill="currentColor" stroke="none" />
        </Svg>
      );
    case "idea":
      return (
        <Svg size={size} label={label}>
          <path d="M8 1.4 9.5 6.5 14.6 8 9.5 9.5 8 14.6 6.5 9.5 1.4 8 6.5 6.5Z" fill="currentColor" stroke="none" />
        </Svg>
      );
    case "review":
      return (
        <Svg size={size} label={label}>
          <path d="M13.2 3v4.4a2.4 2.4 0 0 1-2.4 2.4H3.3" />
          <path d="M6.2 6.9 3.3 9.8l2.9 2.9" />
        </Svg>
      );
    case "note":
      return (
        <Svg size={size} label={label}>
          <path d="M3 4.2h10M3 8h10M3 11.8h6.4" />
        </Svg>
      );
    default:
      return (
        <Svg size={size} label={label}>
          <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
        </Svg>
      );
  }
}

/**
 * A card type's glyph on its chip, in the type's colour (one of the "Mister Coyote" palette; the
 * chip's colours for each theme are in styles.css, `.tone-…`). `types`: the board's types, for a
 * type this page does not know.
 */
export function TypeChip({ type, types, size = 13, small = false }: { type: string; types?: readonly string[]; size?: number; small?: boolean }) {
  return (
    <span className={`type-chip tone-${toneOf(type, types)}${small ? " type-chip-small" : ""}`} data-type={type} data-tone={toneOf(type, types)}>
      <TypeGlyph type={type} size={size} />
    </span>
  );
}

export const BellIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 1.9a3.7 3.7 0 0 0-3.7 3.7v2.2L2.9 10.6h10.2L11.7 7.8V5.6A3.7 3.7 0 0 0 8 1.9Z" />
    <path d="M6.4 12.6a1.7 1.7 0 0 0 3.2 0" />
  </Svg>
);

export const FlagIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3.6 14.2V2.4" />
    <path d="M3.6 2.9h8.2L10 5.7l1.8 2.8H3.6" fill="currentColor" />
  </Svg>
);

export const GearIcon = (props: IconProps) => (
  <Svg {...props} strokeWidth={1.4}>
    <circle cx="8" cy="8" r="3.6" />
    <circle cx="8" cy="8" r="1.3" />
    <path d="M12.6 8h1.9M11.25 11.25l1.35 1.35M8 12.6v1.9M4.75 11.25 3.4 12.6M3.4 8H1.5M4.75 4.75 3.4 3.4M8 3.4V1.5M11.25 4.75l1.35-1.35" strokeWidth={1.9} />
  </Svg>
);

export const BubbleIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.6 3.4h10.8v7.3H7.3l-3 2.5v-2.5H2.6Z" />
  </Svg>
);

export const SearchIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="m10.3 10.3 3.6 3.6" />
  </Svg>
);

export const PlusIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const CloseIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m3.8 3.8 8.4 8.4M12.2 3.8l-8.4 8.4" />
  </Svg>
);

export const ChevronDown = (props: IconProps) => (
  <Svg {...props}>
    <path d="m4 6 4 4 4-4" />
  </Svg>
);

export const ChevronLeft = (props: IconProps) => (
  <Svg {...props}>
    <path d="m10 3.5-4.5 4.5 4.5 4.5" />
  </Svg>
);

export const ChevronRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Svg>
);

export const EditIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M10.6 2.6a1.6 1.6 0 0 1 2.3 2.3L5.6 12.2l-3 .7.7-3Z" />
  </Svg>
);

export const ArchiveIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="1.9" y="2.6" width="12.2" height="3.4" rx=".8" />
    <path d="M3 6v6.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.4 8.6h3.2" />
  </Svg>
);

export const FileIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9.2 1.9H4.4a1 1 0 0 0-1 1v10.2a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V5.3Z" />
    <path d="M9.2 1.9v3.4h3.4" />
  </Svg>
);

export const SunIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="2.9" />
    <path d="M8 1.4v1.4M8 13.2v1.4M1.4 8h1.4M13.2 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M3.3 12.7l1-1M11.7 4.3l1-1" />
  </Svg>
);

export const MoonIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M13.3 9.9A5.6 5.6 0 0 1 6.1 2.7a5.6 5.6 0 1 0 7.2 7.2Z" />
  </Svg>
);

export const SystemIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="5.9" />
    <path d="M8 2.1v11.8A5.9 5.9 0 0 0 8 2.1Z" fill="currentColor" stroke="none" />
  </Svg>
);

export const CollapseIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m9.5 4-4 4 4 4M13 4v8" />
  </Svg>
);

export const ExpandIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m6.5 4 4 4-4 4M3 4v8" />
  </Svg>
);

export const KeysIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="1.6" y="3.8" width="12.8" height="8.4" rx="1.6" />
    <path d="M4.3 6.5h.01M6.8 6.5h.01M9.2 6.5h.01M11.7 6.5h.01M5 9.5h6" strokeWidth={1.7} />
  </Svg>
);

export const ActivityIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M1.6 8.4h2.8l1.8-4.6 3.4 8.6 1.8-4h3" />
  </Svg>
);

/** The CodeLead-AI mark (navy disc, the C in the blue to cyan gradient, the L in white), as the run report draws it. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="CodeLead-AI">
      <defs>
        <linearGradient id="pinboard-mark" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#1E5EFF" />
          <stop offset="1" stopColor="#4FD0FF" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="49" fill="#050B17" />
      <path d="M62 30 A26 26 0 1 0 62 70" fill="none" stroke="url(#pinboard-mark)" strokeWidth="12" />
      <path d="M56 24 L68 24 L68 66 L88 66 L88 76 L56 76 Z" fill="#F4F7FB" />
      <rect x="36" y="53" width="12" height="4" rx="2" fill="#4FD0FF" />
    </svg>
  );
}
