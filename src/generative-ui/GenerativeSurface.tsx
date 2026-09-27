/**
 * The trusted catalog and renderer — the half of A2UI that matters for
 * safety. It switches on `Component["component"]`, a closed union; a type
 * the switch does not recognise renders as a visible placeholder rather than
 * being skipped silently, so a catalog gap is a bug you can see, not one an
 * agent can quietly exploit into running something else.
 */
import { Fragment, useState, type CSSProperties, type ReactNode } from "react";

import { openUrl } from "../lib/github";

import { asString, boundPointer, evaluate, type Scope } from "./evaluate";
import {
  readPointer,
  resolvePointer,
  type Action,
  type Align,
  type ChildList,
  type Component,
  type ComponentId,
  type DataModel,
  type JsonPointer,
  type Justify,
  type SurfaceState,
} from "./schema";
import { readChanges, readComments, readDecisions, readFindings, readNotes, readRequirements, readSources } from "./workItem";
import {
  CommentsNode,
  DecisionsNode,
  FindingsNode,
  PatchPane,
  RequirementsNode,
  SourcesSection,
  WorkItemDetail,
  type Report,
} from "./WorkItemDetail";

/** A button's `event`, with its bindings resolved at click time. */
export interface ResolvedEvent {
  name: string;
  userMessage?: string;
  context: Record<string, unknown>;
}

interface Props {
  surface: SurfaceState;
  dataModel: DataModel;
  onSetValue: (path: JsonPointer, value: unknown) => void;
  onAction: (event: ResolvedEvent, sourceComponentId: ComponentId) => void;
  /** Opens a project-relative file in Roer's viewer; without it, a file a
   * surface names is only named. */
  onOpenFile?: (path: string) => void;
}

interface Ctx extends Omit<Props, "surface"> {
  components: Record<ComponentId, Component>;
}

export function GenerativeSurface({ surface, dataModel, onSetValue, onAction, onOpenFile }: Props) {
  // `createSurface` implies a `Surface` whose only child is "root"; until an
  // agent sends it, there is nothing to draw yet.
  if (!surface.components.root) {
    return <p className="gen-text muted">Waiting for the surface's root component…</p>;
  }
  const ctx: Ctx = { components: surface.components, dataModel, onSetValue, onAction, onOpenFile };
  return <div className="gen-surface">{renderNode("root", ctx, {}, new Set())}</div>;
}

function renderNode(
  id: ComponentId,
  ctx: Ctx,
  scope: Scope,
  ancestors: ReadonlySet<ComponentId>,
  key: string = id,
): ReactNode {
  const node = ctx.components[id];
  if (!node) return <p key={key} className="gen-text muted">[missing component: {id}]</p>;
  // Child ids are agent-provided; a self-referential Card/Row would recurse
  // forever without this, so a cycle renders as a placeholder instead of
  // overflowing the stack and taking the whole panel down.
  if (ancestors.has(id)) {
    return <p key={key} className="gen-text muted">[cyclic component: {id}]</p>;
  }
  const seen = new Set(ancestors).add(id);
  return <Fragment key={key}>{renderBody(node, ctx, scope, seen)}</Fragment>;
}

function renderBody(node: Component, ctx: Ctx, scope: Scope, seen: ReadonlySet<ComponentId>): ReactNode {
  const value = (v: unknown) => evaluate(v, ctx.dataModel, scope);
  const text = (v: unknown) => asString(value(v));
  const child = (childId: ComponentId) => renderNode(childId, ctx, scope, seen);
  const children = (list: ChildList) => renderChildren(list, ctx, scope, seen);
  const write = (v: unknown) => {
    const pointer = boundPointer(v, scope);
    return (next: unknown) => {
      if (pointer) ctx.onSetValue(pointer, next);
    };
  };
  const common = { ...aria(node, value), style: weightStyle(node.weight) };
  const report: Report = (name, context) => ctx.onAction({ name, context }, node.id);

  switch (node.component) {
    case "Row":
      return (
        <div {...common} className="gen-row" style={{ ...common.style, ...flexStyle(node.justify, node.align) }}>
          {children(node.children)}
        </div>
      );
    case "Column":
      return (
        <div {...common} className="gen-column" style={{ ...common.style, ...flexStyle(node.justify, node.align) }}>
          {children(node.children)}
        </div>
      );
    case "List":
      return (
        <div
          {...common}
          className={node.direction === "horizontal" ? "gen-list horizontal" : "gen-list"}
          style={{ ...common.style, ...flexStyle(undefined, node.align) }}
        >
          {children(node.children)}
        </div>
      );
    case "Card":
      return (
        <div {...common} className="gen-card">
          {child(node.child)}
        </div>
      );
    case "Divider":
      return <hr {...common} className={node.axis === "vertical" ? "gen-divider vertical" : "gen-divider"} />;
    case "Text":
      return (
        <p {...common} className={node.variant === "caption" ? "gen-text muted" : "gen-text"}>
          {text(node.text)}
        </p>
      );
    case "Image":
      return (
        <img
          {...common}
          className={`gen-image ${node.variant ?? "mediumFeature"}`}
          style={{ ...common.style, objectFit: objectFit(node.fit) }}
          src={text(node.url)}
          alt={text(node.description)}
        />
      );
    case "Icon": {
      const name = node.name;
      if (typeof name === "object" && name !== null && "svgPath" in name) {
        return (
          <svg {...common} className="gen-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d={text(name.svgPath)} fill="currentColor" />
          </svg>
        );
      }
      return (
        <span {...common} className="gen-icon" aria-hidden="true">
          {text(name)}
        </span>
      );
    }
    case "Video":
      return (
        <video {...common} className="gen-image" src={text(node.url)} poster={text(node.posterUrl) || undefined} controls />
      );
    case "AudioPlayer":
      return (
        <figure {...common} className="gen-audio">
          <audio src={text(node.url)} controls />
          {node.description ? <figcaption className="gen-text muted">{text(node.description)}</figcaption> : null}
        </figure>
      );
    case "Button":
      return (
        <button
          {...common}
          type="button"
          className={node.variant && node.variant !== "default" ? `gen-button ${node.variant}` : "gen-button"}
          onClick={() => {
            const event = resolveEvent(node.action, value);
            if (event) ctx.onAction(event, node.id);
          }}
        >
          {child(node.child)}
        </button>
      );
    case "TextField": {
      const current = text(node.value);
      const set = write(node.value);
      const placeholder = text(node.placeholder) || undefined;
      return (
        <label {...common} className="gen-field">
          <span className="gen-field-label">{text(node.label)}</span>
          {node.variant === "longText" ? (
            <textarea value={current} placeholder={placeholder} onChange={(e) => set(e.target.value)} />
          ) : (
            <input
              type={node.variant === "number" ? "number" : node.variant === "obscured" ? "password" : "text"}
              value={current}
              placeholder={placeholder}
              onChange={(e) => set(node.variant === "number" ? Number(e.target.value) : e.target.value)}
            />
          )}
        </label>
      );
    }
    case "CheckBox": {
      const set = write(node.value);
      return (
        <label {...common} className="gen-checkbox">
          <input type="checkbox" checked={Boolean(value(node.value))} onChange={(e) => set(e.target.checked)} />
          {text(node.label)}
        </label>
      );
    }
    case "Slider": {
      const min = node.min ?? 0;
      const current = Number(value(node.value) ?? min);
      const set = write(node.value);
      return (
        <label {...common} className="gen-slider">
          {node.label ? <span className="gen-field-label">{text(node.label)}</span> : null}
          <input
            type="range"
            min={min}
            max={node.max}
            step={node.steps ? (node.max - min) / node.steps : "any"}
            value={current}
            onChange={(e) => set(Number(e.target.value))}
          />
          <span className="gen-slider-value">{current}</span>
        </label>
      );
    }
    case "DateTimeInput": {
      // Both flags default to off in v1.0; with neither set, offer both
      // rather than an input that can pick nothing.
      const type = node.enableDate && !node.enableTime ? "date" : node.enableTime && !node.enableDate ? "time" : "datetime-local";
      const set = write(node.value);
      return (
        <label {...common} className="gen-field">
          {node.label ? <span className="gen-field-label">{text(node.label)}</span> : null}
          <input
            type={type}
            className="gen-datetime"
            value={text(node.value)}
            min={text(node.min) || undefined}
            max={text(node.max) || undefined}
            onChange={(e) => set(e.target.value)}
          />
        </label>
      );
    }
    case "ChoicePicker":
      return (
        <ChoicePickerNode
          {...common}
          label={node.label ? text(node.label) : undefined}
          options={node.options.map((option) => ({ label: text(option.label), value: option.value }))}
          selected={toStrings(value(node.value))}
          multiple={node.variant === "multipleSelection"}
          chips={node.displayStyle === "chips"}
          filterable={node.filterable ?? false}
          onChange={write(node.value)}
        />
      );
    case "Tabs":
      return (
        <TabsNode
          {...common}
          tabs={node.tabs.map((tab) => ({ title: text(tab.title), child: tab.child }))}
          renderChild={child}
        />
      );
    case "Modal":
      return <ModalNode {...common} trigger={child(node.trigger)} content={child(node.content)} />;
    case "Arrow":
      return (
        <div {...common} className={node.direction === "vertical" ? "gen-arrow vertical" : "gen-arrow horizontal"}>
          {node.label ? <span className="gen-arrow-label">{text(node.label)}</span> : null}
          <span className="gen-arrow-line" />
        </div>
      );
    case "Expandable":
      return (
        <ExpandableNode
          {...common}
          title={text(node.title)}
          defaultExpanded={node.defaultExpanded}
          content={child(node.child)}
        />
      );
    case "DiffView":
      return (
        <PatchPane
          {...common}
          patch={text(node.diff)}
          title={node.title === undefined ? "" : text(node.title)}
          layout={node.layout}
          emptyText={node.emptyText === undefined ? "No changes." : text(node.emptyText)}
          notes={readNotes(value(node.notes))}
        />
      );
    case "WorkItem":
      return (
        <WorkItemNode
          {...common}
          title={text(node.title)}
          source={node.source === undefined ? "" : text(node.source)}
          itemKey={node.key === undefined ? "" : text(node.key)}
          status={node.status === undefined ? "" : text(node.status)}
          url={node.url === undefined ? "" : text(node.url)}
          assignee={node.assignee === undefined ? "" : text(node.assignee)}
          labels={toStrings(value(node.labels))}
          meta={node.meta === undefined ? "" : text(node.meta)}
          footer={node.footer === undefined ? null : child(node.footer)}
          detail={
            node.variant === "detail" ? (
              <WorkItemDetail
                itemKey={node.key === undefined ? "" : text(node.key)}
                goal={node.goal === undefined ? "" : text(node.goal)}
                requirements={readRequirements(value(node.requirements))}
                sources={readSources(value(node.sources))}
                comments={readComments(value(node.comments))}
                changes={readChanges(value(node.changes))}
                findings={readFindings(value(node.findings))}
                decisions={readDecisions(value(node.decisions))}
                report={report}
                onOpenFile={ctx.onOpenFile}
              />
            ) : null
          }
        />
      );
    case "Requirements":
      return <RequirementsNode items={readRequirements(value(node.items))} report={report} />;
    case "Findings":
      return <FindingsNode items={readFindings(value(node.items))} report={report} />;
    case "Decisions":
      return <DecisionsNode items={readDecisions(value(node.items))} report={report} />;
    case "Sources":
      return <SourcesSection items={readSources(value(node.items))} onOpenFile={ctx.onOpenFile} />;
    case "Comments":
      return <CommentsNode items={readComments(value(node.items))} />;
    default: {
      // Exhaustiveness check: a new Component variant fails the build here
      // instead of silently falling through the switch. At runtime this is
      // where an unknown type — raw JSON off the wire — ends up.
      const unknown: never = node;
      const type = (unknown as { component?: unknown }).component;
      return <p className="gen-text muted">[unsupported component: {String(type)}]</p>;
    }
  }
}

/** A fixed list of ids, or one copy of the template per element of the
 * list it is bound to, each evaluated against its own element. */
function renderChildren(list: ChildList, ctx: Ctx, scope: Scope, ancestors: ReadonlySet<ComponentId>): ReactNode {
  if (Array.isArray(list)) return list.map((id) => renderNode(id, ctx, scope, ancestors));
  if (typeof list !== "object" || list === null) return null;
  const pointer = resolvePointer(list.path, scope.item);
  const items = readPointer(ctx.dataModel, pointer);
  if (!Array.isArray(items)) return null;
  return items.map((_, index) =>
    renderNode(list.componentId, ctx, { item: `${pointer}/${index}`, index }, ancestors, `${list.componentId}@${index}`),
  );
}

function resolveEvent(action: Action, value: (v: unknown) => unknown): ResolvedEvent | undefined {
  if (!("event" in action)) {
    // `functionCall` actions run renderer functions, and there are none yet —
    // `openUrl` and Roer's own arrive with the function catalog.
    return undefined;
  }
  const { name, userMessage, context } = action.event;
  return {
    name,
    userMessage: userMessage === undefined ? undefined : asString(value(userMessage)),
    context: Object.fromEntries(Object.entries(context ?? {}).map(([k, v]) => [k, value(v)])),
  };
}

function aria(node: Component, value: (v: unknown) => unknown) {
  const a11y = node.accessibility;
  if (!a11y) return {};
  const label = a11y.label === undefined ? undefined : asString(value(a11y.label));
  const description = a11y.description === undefined ? undefined : asString(value(a11y.description));
  return {
    "aria-label": label || undefined,
    "aria-description": description || undefined,
    "aria-live": a11y.live && a11y.live !== "off" ? a11y.live : undefined,
    "aria-hidden": a11y.hidden === undefined ? undefined : Boolean(value(a11y.hidden)) || undefined,
  };
}

const toStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

const weightStyle = (weight?: number): CSSProperties | undefined =>
  weight === undefined ? undefined : { flexGrow: weight };

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

function objectFit(fit?: "contain" | "cover" | "fill" | "none" | "scaleDown"): CSSProperties["objectFit"] {
  return fit === "scaleDown" ? "scale-down" : fit;
}

interface Common {
  "aria-label"?: string;
  "aria-description"?: string;
  "aria-live"?: "polite" | "assertive";
  "aria-hidden"?: boolean;
  style?: CSSProperties;
}

function ChoicePickerNode({
  label,
  options,
  selected,
  multiple,
  chips,
  filterable,
  onChange,
  ...common
}: Common & {
  label?: string;
  options: { label: string; value: string }[];
  selected: string[];
  multiple: boolean;
  chips: boolean;
  filterable: boolean;
  onChange: (next: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const picked = new Set(selected);
  const toggle = (value: string) => {
    if (!multiple) return onChange(picked.has(value) ? [] : [value]);
    const next = new Set(picked);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(Array.from(next));
  };
  const shown = filter
    ? options.filter((option) => option.label.toLowerCase().includes(filter.toLowerCase()))
    : options;
  return (
    <div {...common} className={chips ? "gen-choice-picker chips" : "gen-choice-picker"}>
      {label ? <span className="gen-field-label">{label}</span> : null}
      {filterable ? (
        <input className="gen-bundles-input" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      ) : null}
      {shown.map((option) =>
        chips ? (
          <button
            key={option.value}
            type="button"
            aria-pressed={picked.has(option.value)}
            className={picked.has(option.value) ? "gen-chip on" : "gen-chip"}
            onClick={() => toggle(option.value)}
          >
            {option.label}
          </button>
        ) : (
          <label key={option.value} className="gen-choice-option">
            <input
              type={multiple ? "checkbox" : "radio"}
              checked={picked.has(option.value)}
              onChange={() => toggle(option.value)}
            />
            {option.label}
          </label>
        ),
      )}
    </div>
  );
}

/** Local, client-only state: whether the modal is open is not part of the
 * protocol, so the trigger and the open flag both live here. */
function ModalNode({ trigger, content, ...common }: Common & { trigger: ReactNode; content: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span {...common} className="gen-modal-trigger" onClick={() => setOpen(true)}>
        {trigger}
      </span>
      {open ? (
        <div className="gen-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="gen-modal" onClick={(e) => e.stopPropagation()}>
            {content}
          </div>
        </div>
      ) : null}
    </>
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
function statusTone(status: string): "done" | "doing" | "blocked" | "todo" {
  const s = status.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  if (["done", "closed", "fixed", "resolved", "completed", "merged", "verified"].includes(s)) return "done";
  if (["doing", "in progress", "in review", "active", "started", "review", "working"].includes(s)) return "doing";
  if (["blocked", "on hold", "waiting"].includes(s)) return "blocked";
  return "todo";
}

function WorkItemNode({
  title,
  source,
  itemKey,
  status,
  url,
  assignee,
  labels,
  meta,
  footer,
  detail,
  ...common
}: Common & {
  title: string;
  source: string;
  itemKey: string;
  status: string;
  url: string;
  assignee: string;
  labels: string[];
  meta: string;
  footer: ReactNode;
  /** The opened-up body, for `variant: "detail"`. */
  detail?: ReactNode;
}) {
  const sourceLabel = SOURCES[source.toLowerCase()] ?? source;
  // The backend refuses anything but an https link too; checking here keeps
  // a title that could not open from looking like a link.
  const link = url.startsWith("https://") ? url : "";
  return (
    <article
      {...common}
      className={detail ? "gen-workitem detail" : "gen-workitem"}
      data-source={source.toLowerCase() || undefined}
    >
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
      {assignee || meta ? (
        <p className="gen-workitem-meta">{[assignee, meta].filter(Boolean).join(" · ")}</p>
      ) : null}
      {detail}
      {footer ? <div className="gen-workitem-footer">{footer}</div> : null}
    </article>
  );
}

/** Same reasoning as `ModalNode`: whether a node is expanded is client-only
 * state, never part of the data model an agent reads or writes. */
function ExpandableNode({
  title,
  defaultExpanded,
  content,
  ...common
}: Common & { title: string; defaultExpanded?: boolean; content: ReactNode }) {
  const [open, setOpen] = useState(defaultExpanded ?? false);
  return (
    <div {...common} className="gen-expandable">
      <button
        type="button"
        className="gen-expandable-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={open ? "gen-expandable-chevron open" : "gen-expandable-chevron"}>▶</span>
        {title}
      </button>
      {open ? <div className="gen-expandable-body">{content}</div> : null}
    </div>
  );
}

/** Same reasoning as `ModalNode`: which tab is active is client-only state,
 * never part of the data model an agent reads or writes. */
function TabsNode({
  tabs,
  renderChild,
  ...common
}: Common & { tabs: { title: string; child: ComponentId }[]; renderChild: (id: ComponentId) => ReactNode }) {
  const [active, setActive] = useState(0);
  return (
    <div {...common} className="gen-tabs">
      <div className="gen-tabs-bar" role="tablist">
        {tabs.map((tab, i) => (
          <button
            key={tab.child}
            type="button"
            role="tab"
            aria-selected={active === i}
            className={active === i ? "gen-tabs-btn on" : "gen-tabs-btn"}
            onClick={() => setActive(i)}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <div className="gen-tabs-panel">{tabs[active] ? renderChild(tabs[active].child) : null}</div>
    </div>
  );
}
