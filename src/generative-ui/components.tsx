/**
 * The catalog's components as plain React: what a Generative UI surface is
 * drawn with (`GenerativeSurface` maps each catalog node onto one of these),
 * and what an extension's tab is built from (`roer/ui`), so the two look and
 * behave as one.
 *
 * Every prop is already a value: bindings, templates and actions are the
 * renderer's business, not these components'.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import {
  Checkbox as CheckboxPrimitive,
  Collapsible as CollapsiblePrimitive,
  Dialog as DialogPrimitive,
  RadioGroup as RadioGroupPrimitive,
  Slider as SliderPrimitive,
  Tabs as TabsPrimitive,
  ToggleGroup as ToggleGroupPrimitive,
  VisuallyHidden,
} from "radix-ui";

import { openUrl } from "../lib/github";

import type { Align, Justify } from "./schema";

export { PatchPane as DiffView } from "./WorkItemDetail";
export { Mermaid, type DiagramComment, type DiagramFile, type DiagramThread } from "./Mermaid";
export { Chart, type ChartOrientation, type ChartSeries, type ChartVariant } from "./Chart";

/** What every component passes to its root element. */
export interface Common {
  "aria-label"?: string;
  "aria-description"?: string;
  "aria-live"?: "polite" | "assertive";
  "aria-hidden"?: boolean;
  style?: CSSProperties;
  /** Comment mode pins comments to the element carrying it. */
  "data-roer-id"?: string;
}

type WithChildren = Common & { children?: ReactNode };

function flexStyle(justify?: Justify, align?: Align): CSSProperties {
  const justifyMap: Record<Justify, string> = {
    start: "flex-start",
    center: "center",
    end: "flex-end",
    spaceBetween: "space-between",
    spaceAround: "space-around",
    spaceEvenly: "space-evenly",
    stretch: "stretch",
  };
  const alignMap: Record<Align, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };
  return {
    justifyContent: justify ? justifyMap[justify] : undefined,
    alignItems: align ? alignMap[align] : undefined,
  };
}

/** `columns` wins when both are set: a fixed count reads as the agent's
 * intent, `minItemWidth` as "wrap by however many fit". */
function gridStyle(columns?: number, minItemWidth?: number): CSSProperties {
  return {
    gridTemplateColumns:
      columns !== undefined
        ? `repeat(${columns}, 1fr)`
        : minItemWidth !== undefined
          ? `repeat(auto-fill, minmax(${minItemWidth}px, 1fr))`
          : undefined,
  };
}

// ---------------------------------------------------------------- layout

export function Row({ justify, align, style, children, ...common }: WithChildren & { justify?: Justify; align?: Align }) {
  return (
    <div {...common} className="gen-row" style={{ ...style, ...flexStyle(justify, align) }}>
      {children}
    </div>
  );
}

export function Column({ justify, align, style, children, ...common }: WithChildren & { justify?: Justify; align?: Align }) {
  return (
    <div {...common} className="gen-column" style={{ ...style, ...flexStyle(justify, align) }}>
      {children}
    </div>
  );
}

export function List({
  direction,
  align,
  style,
  children,
  ...common
}: WithChildren & { direction?: "vertical" | "horizontal"; align?: Align }) {
  return (
    <div
      {...common}
      className={direction === "horizontal" ? "gen-list horizontal" : "gen-list"}
      style={{ ...style, ...flexStyle(undefined, align) }}
    >
      {children}
    </div>
  );
}

export function Card({ children, ...common }: WithChildren) {
  return (
    <div {...common} className="gen-card">
      {children}
    </div>
  );
}

/** The one layout that wraps, for tiles and cards whose count varies. */
export function Grid({
  columns,
  minItemWidth,
  style,
  children,
  ...common
}: WithChildren & { columns?: number; minItemWidth?: number }) {
  return (
    <div {...common} className="gen-grid" style={{ ...style, ...gridStyle(columns, minItemWidth) }}>
      {children}
    </div>
  );
}

export function Divider({ axis, ...common }: Common & { axis?: "horizontal" | "vertical" }) {
  return <hr {...common} className={axis === "vertical" ? "gen-divider vertical" : "gen-divider"} />;
}

/** Client-only state: which tab is active is never part of a data model.
 * Radix gives it the tab pattern: arrow keys between tabs, each tab tied to
 * its panel. */
export function Tabs({ tabs, ...common }: Common & { tabs: { title: string; content: ReactNode }[] }) {
  const [active, setActive] = useState("0");
  const shown = tabs[Number(active)];
  return (
    <TabsPrimitive.Root {...common} className="gen-tabs" value={active} onValueChange={setActive}>
      <TabsPrimitive.List className="gen-tabs-bar">
        {tabs.map((tab, i) => (
          <TabsPrimitive.Trigger
            key={`${i}:${tab.title}`}
            value={String(i)}
            className={active === String(i) ? "gen-tabs-btn on" : "gen-tabs-btn"}
          >
            {tab.title}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {shown ? (
        <TabsPrimitive.Content value={active} className="gen-tabs-panel">
          {shown.content}
        </TabsPrimitive.Content>
      ) : null}
    </TabsPrimitive.Root>
  );
}

/** Client-only state: whether the modal is open is not part of the
 * protocol, so the trigger and the open flag both live here. A Radix dialog:
 * focus moves into it and stays there, Escape or a click outside closes it,
 * and focus goes back to the trigger. */
export function Modal({ trigger, children, ...common }: WithChildren & { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <span {...common} className="gen-modal-trigger" onClick={() => setOpen(true)}>
        {trigger}
      </span>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="gen-modal-backdrop" />
        <DialogPrimitive.Content className="gen-modal" aria-describedby={undefined}>
          {/* A dialog needs a name; a catalog Modal has no title of its own. */}
          <VisuallyHidden.Root asChild>
            <DialogPrimitive.Title>Details</DialogPrimitive.Title>
          </VisuallyHidden.Root>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Same reasoning as `Modal`: whether it is expanded is client-only state. */
export function Expandable({
  title,
  defaultExpanded,
  children,
  ...common
}: WithChildren & { title: string; defaultExpanded?: boolean }) {
  const [open, setOpen] = useState(defaultExpanded ?? false);
  return (
    <CollapsiblePrimitive.Root {...common} className="gen-expandable" open={open} onOpenChange={setOpen}>
      <CollapsiblePrimitive.Trigger className="gen-expandable-header">
        <span className={open ? "gen-expandable-chevron open" : "gen-expandable-chevron"}>▶</span>
        {title}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="gen-expandable-body">{children}</CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

export function Arrow({ direction, label, ...common }: Common & { direction?: "horizontal" | "vertical"; label?: string }) {
  return (
    <div {...common} className={direction === "vertical" ? "gen-arrow vertical" : "gen-arrow horizontal"}>
      {label ? <span className="gen-arrow-label">{label}</span> : null}
      <span className="gen-arrow-line" />
    </div>
  );
}

// ---------------------------------------------------------------- display

export type TextVariant = "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body";

/** `h1`–`h5` are headings, drawn as the HTML heading they name. */
export function Text({ variant, children, ...common }: WithChildren & { variant?: TextVariant }) {
  if (variant !== undefined && variant !== "caption" && variant !== "body") {
    const Heading = variant;
    return (
      <Heading {...common} className={`gen-text gen-heading ${variant}`}>
        {children}
      </Heading>
    );
  }
  return (
    <p {...common} className={variant === "caption" ? "gen-text muted" : "gen-text"}>
      {children}
    </p>
  );
}

export function Image({
  url,
  description,
  fit,
  variant,
  style,
  ...common
}: Common & {
  url: string;
  description?: string;
  fit?: "contain" | "cover" | "fill" | "none" | "scaleDown";
  variant?: "icon" | "avatar" | "smallFeature" | "mediumFeature" | "largeFeature" | "header";
}) {
  return (
    <img
      {...common}
      className={`gen-image ${variant ?? "mediumFeature"}`}
      style={{ ...style, objectFit: fit === "scaleDown" ? "scale-down" : fit }}
      src={url}
      alt={description ?? ""}
    />
  );
}

/** An svg for `{ svgPath }` (a 24×24 path), otherwise the name shown as text. */
export function Icon({ name, ...common }: Common & { name: string | { svgPath: string } }) {
  if (typeof name === "object") {
    return (
      <svg {...common} className="gen-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d={name.svgPath} fill="currentColor" />
      </svg>
    );
  }
  return (
    <span {...common} className="gen-icon" aria-hidden="true">
      {name}
    </span>
  );
}

export function Video({ url, posterUrl, ...common }: Common & { url: string; posterUrl?: string }) {
  return <video {...common} className="gen-image" src={url} poster={posterUrl || undefined} controls />;
}

export function AudioPlayer({ url, description, ...common }: Common & { url: string; description?: string }) {
  return (
    <figure {...common} className="gen-audio">
      <audio src={url} controls />
      {description ? <figcaption className="gen-text muted">{description}</figcaption> : null}
    </figure>
  );
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** A short label in a pill: a status letter, a count, a state. */
export function Badge({ tone = "neutral", children, ...common }: WithChildren & { tone?: Tone }) {
  return (
    <span {...common} className={`gen-badge ${tone}`}>
      {children}
    </span>
  );
}

/** What a tab or a section shows in place of its content: nothing to show
 * (`empty`), not yet (`loading`), or it failed (`error`). It fills the room
 * it is given and centres itself there. */
export function EmptyState({
  text,
  detail,
  variant = "empty",
  footer,
  ...common
}: Common & { text: string; detail?: string; variant?: "empty" | "loading" | "error"; footer?: ReactNode }) {
  return (
    <div
      {...common}
      className={`gen-empty-state is-${variant}`}
      role={variant === "error" ? "alert" : variant === "loading" ? "status" : undefined}
    >
      {variant === "loading" ? <span className="gen-spinner" aria-hidden="true" /> : null}
      <p className="gen-empty-state-text">{text}</p>
      {detail ? <p className="gen-empty-state-detail">{detail}</p> : null}
      {footer ? <div className="gen-empty-state-footer">{footer}</div> : null}
    </div>
  );
}

export interface TableColumn {
  /** The field of each row this column shows. */
  key: string;
  title: string;
  /** `end` for numbers. */
  align?: "start" | "end";
  /** In px; columns without one share what is left. */
  width?: number;
  /** Monospaced, for times, ids, paths and codes. */
  mono?: boolean;
}

/** Rows of records under column headings, e.g. a request log. A row whose
 * `toneKey` field reads as failed or blocked (`statusTone`) is coloured so. */
export function Table({
  columns,
  rows,
  toneKey,
  emptyText = "Nothing to show.",
  source,
  ...common
}: Common & { columns: TableColumn[]; rows: Record<string, ReactNode>[]; toneKey?: string; emptyText?: string; source?: string }) {
  return (
    <div {...common} className="gen-table-wrap">
      <table className="gen-table">
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={column.width === undefined ? undefined : { width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.align === "end" ? "end" : undefined}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="gen-table-empty" colSpan={columns.length}>
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} className={toneKey === undefined ? undefined : `tone-${statusTone(String(row[toneKey] ?? ""))}`}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={[column.align === "end" ? "end" : "", column.mono ? "mono" : ""].filter(Boolean).join(" ") || undefined}
                  >
                    {row[column.key] ?? ""}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {source ? <p className="gen-source">{source}</p> : null}
    </div>
  );
}

/** How each tracker is named on an item; anything else is shown as sent. */
const SOURCES: Record<string, string> = {
  github: "GitHub",
  youtrack: "YouTrack",
  notion: "Notion",
  jira: "Jira",
  personal: "Personal",
};

/** A status, by what it means for the work rather than what a tracker calls
 * it: every tracker spells "finished" its own way. */
export function statusTone(status: string): "done" | "doing" | "blocked" | "failed" | "todo" {
  const s = status.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  if (
    [
      "done", "closed", "fixed", "resolved", "completed", "merged", "verified", "success", "succeeded", "passed", "deployed",
      "connected", "enabled", "online", "healthy", "ok", "up to date",
    ].includes(s)
  )
    return "done";
  if (["doing", "in progress", "in review", "active", "started", "review", "working", "running"].includes(s)) return "doing";
  if (["blocked", "on hold", "waiting"].includes(s)) return "blocked";
  if (["failed", "failure", "error", "errored", "broken"].includes(s)) return "failed";
  return "todo";
}

/** A KPI number for a dashboard, e.g. "12 running jobs". */
export function StatTile({
  label,
  value,
  trend,
  icon,
  source,
  ...common
}: Common & {
  label: string;
  value: string | number;
  trend?: { delta: string | number; direction: "up" | "down" | "flat" };
  icon?: ReactNode;
  source?: string;
}) {
  return (
    <div {...common} className="gen-stat-tile">
      {icon ? <div className="gen-stat-tile-icon">{icon}</div> : null}
      <div className="gen-stat-tile-body">
        <span className="gen-stat-tile-value">{value}</span>
        <span className="gen-stat-tile-label">{label}</span>
        {source ? <span className="gen-source">{source}</span> : null}
      </div>
      {trend ? (
        <span className={`gen-stat-tile-trend ${trend.direction}`}>
          {trend.direction === "up" ? "▲" : trend.direction === "down" ? "▼" : "•"} {trend.delta}
        </span>
      ) : null}
    </div>
  );
}

/** A generic SDLC entity — a ticket, a CI run, a deployment, a running job —
 * dense enough to sit beside unrelated kinds of thing on one dashboard,
 * unlike `WorkItem`'s tracker-specific layout. */
export function StatusCard({
  title,
  subtitle = "",
  meta = "",
  icon,
  status = "",
  progress,
  url = "",
  footer,
  ...common
}: Common & {
  title: string;
  subtitle?: string;
  meta?: string;
  icon?: ReactNode;
  /** Coloured by meaning (`statusTone`): "done", "running", "blocked", "failed", … */
  status?: string;
  /** 0-100, drawn as a slim bar. */
  progress?: number;
  /** An https link; the title opens it in the browser. */
  url?: string;
  footer?: ReactNode;
}) {
  // The backend refuses anything but an https link too; checking here keeps
  // a title that could not open from looking like a link.
  const link = url.startsWith("https://") ? url : "";
  const clampedProgress = progress === undefined ? undefined : Math.min(100, Math.max(0, progress));
  return (
    <article {...common} className="gen-status-card">
      <header className="gen-status-card-head">
        {icon ? <span className="gen-status-card-icon">{icon}</span> : null}
        {link ? (
          <button type="button" className="link gen-status-card-title" title={link} onClick={() => void openUrl(link)}>
            {title}
          </button>
        ) : (
          <span className="gen-status-card-title">{title}</span>
        )}
        {status ? <span className={`gen-status-card-status ${statusTone(status)}`}>{status}</span> : null}
      </header>
      {subtitle || meta ? <p className="gen-status-card-meta">{[subtitle, meta].filter(Boolean).join(" · ")}</p> : null}
      {clampedProgress === undefined ? null : (
        <div className="gen-status-card-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={clampedProgress}>
          <div className="gen-status-card-progress-fill" style={{ width: `${clampedProgress}%` }} />
        </div>
      )}
      {footer ? <div className="gen-status-card-footer">{footer}</div> : null}
    </article>
  );
}

/** One task from any tracker, drawn the same way whichever it is from. */
export function WorkItem({
  title,
  source = "",
  itemKey = "",
  status = "",
  url = "",
  assignee = "",
  labels = [],
  meta = "",
  footer,
  detail,
  ...common
}: Common & {
  title: string;
  /** `github`, `youtrack`, `notion`, `jira`, `personal`, or any other name. */
  source?: string;
  /** The tracker's own id: `#21`, `RO-12`. */
  itemKey?: string;
  status?: string;
  url?: string;
  assignee?: string;
  labels?: string[];
  meta?: string;
  footer?: ReactNode;
  /** The opened-up body of a `detail` work item. */
  detail?: ReactNode;
}) {
  const sourceLabel = SOURCES[source.toLowerCase()] ?? source;
  const link = url.startsWith("https://") ? url : "";
  return (
    <article {...common} className={detail ? "gen-workitem detail" : "gen-workitem"} data-source={source.toLowerCase() || undefined}>
      <header className="gen-workitem-head">
        {sourceLabel ? <span className="gen-workitem-source">{sourceLabel}</span> : null}
        {itemKey ? <span className="gen-workitem-key">{itemKey}</span> : null}
        {status ? <span className={`gen-workitem-status ${statusTone(status)}`}>{status}</span> : null}
      </header>
      {link ? (
        <button type="button" className="link gen-workitem-title" title={link} onClick={() => void openUrl(link)}>
          {title}
        </button>
      ) : (
        <span className="gen-workitem-title">{title}</span>
      )}
      {labels.length > 0 ? (
        <ul className="gen-workitem-labels" aria-label="Labels">
          {labels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      ) : null}
      {assignee || meta ? <p className="gen-workitem-meta">{[assignee, meta].filter(Boolean).join(" · ")}</p> : null}
      {detail}
      {footer ? <div className="gen-workitem-footer">{footer}</div> : null}
    </article>
  );
}

// ---------------------------------------------------------------- input

export function Button({
  variant,
  onClick,
  disabled,
  children,
  ...common
}: WithChildren & { variant?: "default" | "primary" | "borderless"; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      {...common}
      type="button"
      className={variant && variant !== "default" ? `gen-button ${variant}` : "gen-button"}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Without a `label` it is a bare box, e.g. a filter over a list, named for
 * screen readers by its `aria-label` or else its placeholder. */
export function TextField({
  label,
  value,
  placeholder,
  variant,
  onChange,
  onSubmit,
  ...common
}: Common & {
  label?: string;
  value: string;
  placeholder?: string;
  variant?: "shortText" | "longText" | "number" | "obscured" | "search";
  /** A number for the `number` variant, otherwise the text. */
  onChange: (value: string | number) => void;
  /** Enter in a one-line field. */
  onSubmit?: () => void;
}) {
  const { "aria-label": ariaLabel, ...rest } = common;
  const name = label ? undefined : ariaLabel || placeholder || undefined;
  return (
    <label {...rest} aria-label={label ? ariaLabel : undefined} className={variant === "search" ? "gen-field search" : "gen-field"}>
      {label ? <span className="gen-field-label">{label}</span> : null}
      {variant === "longText" ? (
        <textarea aria-label={name} value={value} placeholder={placeholder || undefined} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          aria-label={name}
          type={variant === "number" ? "number" : variant === "obscured" ? "password" : variant === "search" ? "search" : "text"}
          value={value}
          placeholder={placeholder || undefined}
          onChange={(e) => onChange(variant === "number" ? Number(e.target.value) : e.target.value)}
          onKeyDown={
            onSubmit
              ? (e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    onSubmit();
                  }
                }
              : undefined
          }
        />
      )}
    </label>
  );
}

/** A Radix checkbox: a real `role="checkbox"`, drawn in Roer's colours. */
function Box({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label?: string }) {
  return (
    <CheckboxPrimitive.Root
      className="gen-check"
      checked={checked}
      aria-label={label}
      onCheckedChange={(next) => onChange(next === true)}
    >
      <CheckboxPrimitive.Indicator className="gen-check-mark">
        <CheckIcon size={11} strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function CheckBox({ label, checked, onChange, ...common }: Common & { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label {...common} className="gen-checkbox">
      <Box checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

/** A value in steps from `min` to `max`, by keyboard as well as by mouse. */
export function Slider({
  label,
  min = 0,
  max,
  steps,
  value,
  onChange,
  ...common
}: Common & { label?: string; min?: number; max: number; steps?: number; value: number; onChange: (value: number) => void }) {
  const { "aria-label": ariaLabel, ...rest } = common;
  // A float step leaves 0.30000000000000004 behind; round it away.
  const tidy = (v: number) => Number(v.toPrecision(12));
  return (
    <div {...rest} className="gen-slider">
      {label ? <span className="gen-field-label">{label}</span> : null}
      <SliderPrimitive.Root
        className="gen-slider-root"
        min={min}
        max={max}
        step={tidy((max - min) / (steps && steps > 0 ? steps : 100))}
        value={[Math.min(max, Math.max(min, value))]}
        onValueChange={([next]) => next !== undefined && onChange(tidy(next))}
      >
        <SliderPrimitive.Track className="gen-slider-track">
          <SliderPrimitive.Range className="gen-slider-range" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="gen-slider-thumb" aria-label={label || ariaLabel || "Value"} />
      </SliderPrimitive.Root>
      <span className="gen-slider-value">{value}</span>
    </div>
  );
}

export function DateTimeInput({
  label,
  value,
  enableDate,
  enableTime,
  min,
  max,
  onChange,
  ...common
}: Common & {
  label?: string;
  value: string;
  enableDate?: boolean;
  enableTime?: boolean;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}) {
  // Both flags default to off in v1.0; with neither set, offer both
  // rather than an input that can pick nothing.
  const type = enableDate && !enableTime ? "date" : enableTime && !enableDate ? "time" : "datetime-local";
  return (
    <label {...common} className="gen-field">
      {label ? <span className="gen-field-label">{label}</span> : null}
      <input
        type={type}
        className="gen-datetime"
        value={value}
        min={min || undefined}
        max={max || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function ChoicePicker({
  label,
  options,
  value,
  multiple = false,
  chips = false,
  filterable = false,
  onChange,
  ...common
}: Common & {
  label?: string;
  options: { label: string; value: string }[];
  /** The values picked. */
  value: string[];
  multiple?: boolean;
  chips?: boolean;
  filterable?: boolean;
  onChange: (value: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const picked = new Set(value);
  const toggle = (option: string) => {
    if (!multiple) return onChange(picked.has(option) ? [] : [option]);
    const next = new Set(picked);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(Array.from(next));
  };
  const shown = filter ? options.filter((option) => option.label.toLowerCase().includes(filter.toLowerCase())) : options;
  const filterBox = filterable ? (
    <input className="gen-bundles-input" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
  ) : null;
  const heading = label ? <span className="gen-field-label">{label}</span> : null;
  // Chips are a Radix toggle group, a single choice a radio group: either way
  // arrow keys move between the options and Tab leaves them.
  if (chips) {
    const items = shown.map((option) => (
      <ToggleGroupPrimitive.Item
        key={option.value}
        value={option.value}
        className={picked.has(option.value) ? "gen-chip on" : "gen-chip"}
      >
        {option.label}
      </ToggleGroupPrimitive.Item>
    ));
    return (
      <div {...common} className="gen-choice-picker chips">
        {heading}
        {filterBox}
        {multiple ? (
          <ToggleGroupPrimitive.Root type="multiple" className="gen-choice-group" aria-label={label} value={value} onValueChange={onChange}>
            {items}
          </ToggleGroupPrimitive.Root>
        ) : (
          <ToggleGroupPrimitive.Root
            type="single"
            className="gen-choice-group"
            aria-label={label}
            value={value[0] ?? ""}
            onValueChange={(next) => onChange(next ? [next] : [])}
          >
            {items}
          </ToggleGroupPrimitive.Root>
        )}
      </div>
    );
  }
  if (!multiple) {
    return (
      <div {...common} className="gen-choice-picker">
        {heading}
        {filterBox}
        <RadioGroupPrimitive.Root
          className="gen-choice-group column"
          aria-label={label}
          value={value[0] ?? ""}
          onValueChange={(next) => onChange([next])}
        >
          {shown.map((option) => (
            <label key={option.value} className="gen-choice-option">
              <RadioGroupPrimitive.Item value={option.value} className="gen-radio">
                <RadioGroupPrimitive.Indicator className="gen-radio-dot" />
              </RadioGroupPrimitive.Item>
              {option.label}
            </label>
          ))}
        </RadioGroupPrimitive.Root>
      </div>
    );
  }
  return (
    <div {...common} className="gen-choice-picker">
      {heading}
      {filterBox}
      {shown.map((option) => (
        <label key={option.value} className="gen-choice-option">
          <Box checked={picked.has(option.value)} onChange={() => toggle(option.value)} />
          {option.label}
        </label>
      ))}
    </div>
  );
}
