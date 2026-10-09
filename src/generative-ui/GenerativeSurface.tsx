/**
 * The trusted catalog and renderer — the half of A2UI that matters for
 * safety. It switches on `Component["component"]`, a closed union; a type
 * the switch does not recognise renders as a visible placeholder rather than
 * being skipped silently, so a catalog gap is a bug you can see, not one an
 * agent can quietly exploit into running something else.
 */
import { Fragment, type CSSProperties, type ReactNode } from "react";

import {
  Arrow,
  AudioPlayer,
  Badge,
  Button,
  Card,
  CheckBox,
  ChoicePicker,
  Column,
  DateTimeInput,
  DiffView,
  Divider,
  EmptyState,
  Expandable,
  Grid,
  Icon,
  Image,
  List,
  Mermaid,
  Modal,
  Row,
  Slider,
  StatTile,
  StatusCard,
  Table,
  Tabs,
  Text,
  TextField,
  Video,
  WorkItem,
  type Tone,
} from "./components";
import { asString, boundPointer, evaluate, type Scope } from "./evaluate";
import {
  readPointer,
  resolvePointer,
  type Action,
  type ChildList,
  type Component,
  type ComponentId,
  type DataModel,
  type JsonPointer,
  type SurfaceState,
} from "./schema";
import {
  readChanges,
  readComments,
  readDecisions,
  readDiagramFiles,
  readDiagramThreads,
  readFindings,
  readNoteActions,
  readNotes,
  readRequirements,
  readSources,
} from "./workItem";
import {
  CommentsNode,
  DecisionsNode,
  FindingsNode,
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
  ancestors: ReadonlySet<string>,
  key: string = id,
): ReactNode {
  const node = ctx.components[id];
  if (!node) return <p key={key} className="gen-text muted">[missing component: {id}]</p>;
  // Child ids are agent-provided; a self-referential Card/Row would recurse
  // forever without this, so a cycle renders as a placeholder instead of
  // overflowing the stack and taking the whole panel down. A component met
  // again over a deeper element of the data model is not a cycle but a tree
  // (a folder template inside its own folders): the data runs out first.
  const visit = `${id}\0${scope.item ?? ""}`;
  if (ancestors.has(visit)) {
    return <p key={key} className="gen-text muted">[cyclic component: {id}]</p>;
  }
  const seen = new Set(ancestors).add(visit);
  return <Fragment key={key}>{renderBody(node, ctx, scope, seen)}</Fragment>;
}

function renderBody(node: Component, ctx: Ctx, scope: Scope, seen: ReadonlySet<string>): ReactNode {
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
      return <Row {...common} justify={node.justify} align={node.align}>{children(node.children)}</Row>;
    case "Column":
      return <Column {...common} justify={node.justify} align={node.align}>{children(node.children)}</Column>;
    case "List":
      return <List {...common} direction={node.direction} align={node.align}>{children(node.children)}</List>;
    case "Card":
      return <Card {...common}>{child(node.child)}</Card>;
    case "Grid":
      return <Grid {...common} columns={node.columns} minItemWidth={node.minItemWidth}>{children(node.children)}</Grid>;
    case "Divider":
      return <Divider {...common} axis={node.axis} />;
    case "Text":
      return <Text {...common} variant={node.variant}>{text(node.text)}</Text>;
    case "Image":
      return (
        <Image
          {...common}
          url={text(node.url)}
          description={text(node.description)}
          fit={node.fit}
          variant={node.variant}
        />
      );
    case "Icon":
      return <Icon {...common} name={iconName(node.name, text)} />;
    case "Video":
      return <Video {...common} url={text(node.url)} posterUrl={text(node.posterUrl)} />;
    case "AudioPlayer":
      return (
        <AudioPlayer {...common} url={text(node.url)} description={node.description ? text(node.description) : undefined} />
      );
    case "Button":
      return (
        <Button
          {...common}
          variant={node.variant}
          onClick={() => {
            const event = resolveEvent(node.action, value);
            if (event) ctx.onAction(event, node.id);
          }}
        >
          {child(node.child)}
        </Button>
      );
    case "TextField": {
      const submit = node.action;
      return (
        <TextField
          {...common}
          label={node.label === undefined ? undefined : text(node.label)}
          value={text(node.value)}
          placeholder={text(node.placeholder)}
          variant={node.variant}
          onChange={write(node.value)}
          onSubmit={
            submit
              ? () => {
                  const event = resolveEvent(submit, value);
                  if (event) ctx.onAction(event, node.id);
                }
              : undefined
          }
        />
      );
    }
    case "CheckBox":
      return <CheckBox {...common} label={text(node.label)} checked={Boolean(value(node.value))} onChange={write(node.value)} />;
    case "Slider": {
      const min = node.min ?? 0;
      return (
        <Slider
          {...common}
          label={node.label ? text(node.label) : undefined}
          min={min}
          max={node.max}
          steps={node.steps}
          value={Number(value(node.value) ?? min)}
          onChange={write(node.value)}
        />
      );
    }
    case "DateTimeInput":
      return (
        <DateTimeInput
          {...common}
          label={node.label ? text(node.label) : undefined}
          value={text(node.value)}
          enableDate={node.enableDate}
          enableTime={node.enableTime}
          min={text(node.min)}
          max={text(node.max)}
          onChange={write(node.value)}
        />
      );
    case "ChoicePicker":
      return (
        <ChoicePicker
          {...common}
          label={node.label ? text(node.label) : undefined}
          options={node.options.map((option) => ({ label: text(option.label), value: option.value }))}
          value={toStrings(value(node.value))}
          multiple={node.variant === "multipleSelection"}
          chips={node.displayStyle === "chips"}
          filterable={node.filterable ?? false}
          onChange={write(node.value)}
        />
      );
    case "Tabs":
      return <Tabs {...common} tabs={node.tabs.map((tab) => ({ title: text(tab.title), content: child(tab.child) }))} />;
    case "Modal":
      return <Modal {...common} trigger={child(node.trigger)}>{child(node.content)}</Modal>;
    case "Arrow":
      return <Arrow {...common} direction={node.direction} label={node.label ? text(node.label) : undefined} />;
    case "Expandable":
      return (
        <Expandable {...common} title={text(node.title)} defaultExpanded={node.defaultExpanded}>
          {child(node.child)}
        </Expandable>
      );
    case "Badge":
      return <Badge {...common} tone={toneOf(value(node.tone))}>{text(node.text)}</Badge>;
    case "EmptyState":
      return (
        <EmptyState
          {...common}
          text={text(node.text)}
          detail={node.detail === undefined ? undefined : text(node.detail)}
          variant={node.variant}
          footer={node.footer === undefined ? null : child(node.footer)}
        />
      );
    case "Table": {
      const rows = value(node.rows);
      return (
        <Table
          {...common}
          columns={node.columns.map((column) => ({ ...column, title: text(column.title) }))}
          rows={Array.isArray(rows) ? rows.filter(isRecord).map((row) => mapValues(row, asString)) : []}
          toneKey={node.toneKey}
          emptyText={node.emptyText === undefined ? undefined : text(node.emptyText)}
        />
      );
    }
    case "DiffView":
      return (
        <DiffView
          {...common}
          patch={text(node.diff)}
          title={node.title === undefined ? "" : text(node.title)}
          layout={node.layout}
          emptyText={node.emptyText === undefined ? "No changes." : text(node.emptyText)}
          notes={readNotes(value(node.notes))}
          noteActions={readNoteActions(node.noteActions)}
          onNoteAnswer={({ note, action, text: words }) =>
            report(node.noteEvent ?? "diffNote", {
              id: note.id,
              path: note.path,
              line: note.line ?? null,
              side: note.side ?? "new",
              action,
              ...(words === undefined ? {} : { text: words }),
            })
          }
        />
      );
    case "Mermaid":
      return (
        <Mermaid
          {...common}
          source={text(node.source)}
          title={node.title === undefined ? undefined : text(node.title)}
          notes={readDiagramThreads(value(node.notes))}
          files={readDiagramFiles(value(node.files))}
          onOpenFile={ctx.onOpenFile}
          onComment={
            node.comments === false
              ? undefined
              : (comment) => report(node.commentEvent ?? "diagramComment", { ...comment })
          }
        />
      );
    case "StatTile":
      return (
        <StatTile
          {...common}
          label={text(node.label)}
          value={text(node.value)}
          trend={node.trend ? { delta: text(node.trend.delta), direction: node.trend.direction } : undefined}
          icon={node.icon === undefined ? undefined : <Icon name={iconName(node.icon, text)} />}
        />
      );
    case "StatusCard":
      return (
        <StatusCard
          {...common}
          title={text(node.title)}
          subtitle={node.subtitle === undefined ? "" : text(node.subtitle)}
          meta={node.meta === undefined ? "" : text(node.meta)}
          icon={node.icon === undefined ? undefined : <Icon name={iconName(node.icon, text)} />}
          status={node.status === undefined ? "" : text(node.status)}
          progress={node.progress === undefined ? undefined : progressValue(value(node.progress))}
          url={node.url === undefined ? "" : text(node.url)}
          footer={node.footer === undefined ? null : child(node.footer)}
        />
      );
    case "WorkItem":
      return (
        <WorkItem
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
function renderChildren(list: ChildList, ctx: Ctx, scope: Scope, ancestors: ReadonlySet<string>): ReactNode {
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const mapValues = <T,>(record: Record<string, unknown>, f: (v: unknown) => T): Record<string, T> =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, f(v)]));

const TONES: readonly string[] = ["neutral", "accent", "success", "warning", "danger"] satisfies Tone[];
const toneOf = (v: unknown): Tone => (typeof v === "string" && TONES.includes(v) ? (v as Tone) : "neutral");

const weightStyle = (weight?: number): CSSProperties | undefined =>
  weight === undefined ? undefined : { flexGrow: weight };

/** An icon's `name`, a string or `{ svgPath }`, with its bindings resolved. */
function iconName(name: unknown, text: (v: unknown) => string): string | { svgPath: string } {
  if (typeof name === "object" && name !== null && "svgPath" in name) {
    return { svgPath: text((name as { svgPath: unknown }).svgPath) };
  }
  return text(name);
}

/** A bound `progress` resolves to nothing for an item that has none — a
 * template over runs where only some are mid-run — and that must draw no
 * bar rather than `Number(undefined)`'s NaN, which CSS reads as a full one.
 * Only a number or a numeric string counts: `Number` would also turn
 * `false`, `null` and `" "` into 0 and draw an empty bar for them. */
function progressValue(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
