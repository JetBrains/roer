/**
 * A chart of rows from the data model: grouped columns, stacked columns for
 * part-to-whole, or lines for change over a sequence. Drawn as SVG in Roer's
 * own page from the catalog's trusted code, never from the agent's.
 *
 * The rules are fixed rather than left to whoever sends the surface: one
 * value axis, at most eight series in a fixed colour order (`--roer-series-N`,
 * stepped per theme), a legend once there are two, and a table of the same
 * rows a click away, which is also where the values are for anyone who
 * cannot tell the colours apart. A value that is not a number is a gap,
 * never a zero.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { toNumber } from "./functions";
import { Table, type Common } from "./components";

export type ChartVariant = "bar" | "stackedBar" | "line";
/** Columns stand up from the bottom; horizontal bars run right from labels
 * on the left, for long labels or a ranking. Lines are always vertical. */
export type ChartOrientation = "vertical" | "horizontal";

export interface ChartSeries {
  /** The field of each row this series plots. */
  key: string;
  title: string;
}

/** More than this many series cannot keep their colours apart. */
export const MAX_SERIES = 8;

const HEIGHT = 200;
const PAD = { top: 8, right: 12, bottom: 22, left: 40 };
/** A column is never thicker than this, however few there are. */
const MAX_BAR = 24;
/** The surface-coloured gap between touching marks. */
const GAP = 2;
const RADIUS = 4;

const tickFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const valueFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** Ticks at a round step (1, 2 or 5 times a power of ten) covering
 * `[low, high]`, zero always among them. */
export function niceTicks(low: number, high: number, count = 4): number[] {
  const lo = Math.min(0, low);
  const hi = Math.max(0, high);
  if (lo === hi) return [0, 1];
  const raw = (hi - lo) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const ticks: number[] = [];
  for (let t = Math.floor(lo / step) * step; t < hi + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  if (ticks[ticks.length - 1]! < hi) ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)));
  return ticks;
}

/** A horizontal bar from `base` to `end` along x, `top` to `top + thickness`
 * down, with its data end rounded and its baseline end square. */
function barPath(top: number, thickness: number, base: number, end: number, rounded: boolean): string {
  const right = end >= base;
  const r = rounded ? Math.min(RADIUS, thickness / 2, Math.abs(end - base)) : 0;
  const s = right ? 1 : -1;
  return [
    `M${base},${top}`,
    `H${end - s * r}`,
    r ? `Q${end},${top} ${end},${top + r}` : "",
    `V${top + thickness - r}`,
    r ? `Q${end},${top + thickness} ${end - s * r},${top + thickness}` : "",
    `H${base}`,
    "Z",
  ].join("");
}

/** A column from `base` to `top` with its data end rounded and its baseline
 * end square, whichever way it points. */
function columnPath(x: number, width: number, base: number, top: number, rounded: boolean): string {
  const up = top <= base;
  const r = rounded ? Math.min(RADIUS, width / 2, Math.abs(base - top)) : 0;
  const s = up ? 1 : -1;
  return [
    `M${x},${base}`,
    `V${top + s * r}`,
    r ? `Q${x},${top} ${x + r},${top}` : "",
    `H${x + width - r}`,
    r ? `Q${x + width},${top} ${x + width},${top + s * r}` : "",
    `V${base}`,
    "Z",
  ].join("");
}

const seriesColor = (i: number) => `var(--roer-series-${(i % MAX_SERIES) + 1})`;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Chart({
  variant = "bar",
  orientation = "vertical",
  title,
  rows,
  x,
  series,
  source,
  height = HEIGHT,
  emptyText = "Nothing to chart.",
  ...common
}: Common & {
  variant?: ChartVariant;
  orientation?: ChartOrientation;
  title?: string;
  rows: Record<string, unknown>[];
  /** The field of each row that names it: along the bottom, or on the left
   * of horizontal bars. */
  x: string;
  series: ChartSeries[];
  source?: string;
  height?: number;
  emptyText?: string;
}) {
  const [ref, width] = useWidth();
  const [asTable, setAsTable] = useState(false);
  const [active, setActive] = useState<number | undefined>(undefined);
  const tipId = useId();
  const shown = series.slice(0, MAX_SERIES);
  const dropped = series.length - shown.length;
  const label = (row: Record<string, unknown>) => {
    const v = row[x];
    return v === undefined || v === null ? "" : String(v);
  };
  const values = rows.map((row) => shown.map((s) => toNumber(row[s.key])));
  const empty = rows.length === 0 || shown.length === 0 || values.every((vs) => vs.every((v) => v === undefined));

  const head = (
    <div className="gen-chart-head">
      {title ? <span className="gen-chart-title">{title}</span> : <span />}
      {!empty && (
        <button type="button" className="gen-chart-toggle" aria-pressed={asTable} onClick={() => setAsTable((t) => !t)}>
          {asTable ? "Chart" : "Table"}
        </button>
      )}
    </div>
  );
  const foot = (
    <>
      {dropped > 0 ? (
        <p className="gen-chart-note">
          {dropped} more series not drawn: a chart keeps {MAX_SERIES} apart at most.
        </p>
      ) : null}
      {source ? <p className="gen-chart-source">{source}</p> : null}
    </>
  );

  if (empty) {
    return (
      <div {...common} className="gen-chart">
        {head}
        <p className="gen-chart-empty">{emptyText}</p>
        {foot}
      </div>
    );
  }

  if (asTable) {
    return (
      <div {...common} className="gen-chart">
        {head}
        <Table
          columns={[{ key: x, title: "" }, ...shown.map((s) => ({ key: s.key, title: s.title, align: "end" as const }))]}
          rows={rows.map((row, i) => ({
            [x]: label(row),
            ...Object.fromEntries(shown.map((s, j) => [s.key, values[i]![j] === undefined ? "" : valueFormat.format(values[i]![j]!)])),
          }))}
        />
        {foot}
      </div>
    );
  }

  const stacked = variant === "stackedBar";
  // Stacks add up what is there; a part below zero has no place in a whole.
  const totals = values.map((vs) => vs.reduce<number>((sum, v) => sum + Math.max(0, v ?? 0), 0));
  const flat = values.flat().filter((v): v is number => v !== undefined);
  const ticks = stacked ? niceTicks(0, Math.max(...totals)) : niceTicks(Math.min(...flat), Math.max(...flat));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const horizontal = orientation === "horizontal" && variant !== "line";
  const move = (step: number) =>
    setActive((a) => Math.min(rows.length - 1, Math.max(0, (a ?? (step > 0 ? -1 : rows.length)) + step)));
  const legend =
    shown.length > 1 ? (
      <ul className="gen-chart-legend">
        {shown.map((s, j) => (
          <li key={s.key}>
            <span className={`gen-chart-key ${variant === "line" ? "line" : ""}`} style={{ background: seriesColor(j) }} />
            {s.title}
          </li>
        ))}
      </ul>
    ) : null;
  const readout = (i: number, left: number, top: number) => (
    <div id={tipId} role="status" className="gen-chart-tip" style={{ left: Math.min(Math.max(left, 70), width - 70), top }}>
      <span className="gen-chart-tip-label">{label(rows[i]!)}</span>
      {shown.map((s, j) => (
        <span key={s.key} className="gen-chart-tip-row">
          <span className="gen-chart-key line" style={{ background: seriesColor(j) }} />
          <strong>{values[i]![j] === undefined ? "–" : valueFormat.format(values[i]![j]!)}</strong>
          {shown.length > 1 ? <span className="gen-chart-tip-series">{s.title}</span> : null}
        </span>
      ))}
    </div>
  );

  if (horizontal) {
    // Labels take what they need, up to two fifths of the width; the bars
    // keep the rest, and one series writes its value at each bar's tip.
    const longest = Math.max(...rows.map((row) => label(row).length));
    const labelW = Math.min(Math.max(48, longest * 6.6 + 14), width * 0.4);
    const maxChars = Math.max(4, Math.floor((labelW - 14) / 6.6));
    const pad = { top: 4, right: shown.length === 1 ? 44 : 14, bottom: 22, left: labelW };
    const thickness = stacked || shown.length === 1 ? 18 : 14;
    const groupH = stacked ? thickness : thickness * shown.length + GAP * (shown.length - 1);
    const rowH = groupH + 12;
    const plotW = Math.max(40, width - pad.left - pad.right);
    const plotH = rowH * rows.length;
    const svgH = pad.top + plotH + pad.bottom;
    const xAt = (v: number) => pad.left + ((v - lo) / (hi - lo)) * plotW;
    const rowTop = (i: number) => pad.top + rowH * i;
    const bars: ReactNode[] = [];
    values.forEach((vs, i) => {
      const top = rowTop(i) + (rowH - groupH) / 2;
      const dim = active === undefined || active === i ? 1 : 0.55;
      if (stacked) {
        let stack = 0;
        const last = vs.map((v, j) => ((v ?? 0) > 0 ? j : -1)).filter((j) => j >= 0).pop();
        vs.forEach((v, j) => {
          if (v === undefined || v <= 0) return;
          const base = xAt(stack);
          stack += v;
          // The gap between segments is taken from the left one's end.
          const end = xAt(stack) - (j === last ? 0 : GAP);
          if (end - base <= 0) return;
          bars.push(<path key={`${i}-${j}`} d={barPath(top, thickness, base, end, j === last)} fill={seriesColor(j)} opacity={dim} />);
        });
      } else {
        vs.forEach((v, j) => {
          if (v === undefined) return;
          bars.push(
            <path key={`${i}-${j}`} d={barPath(top + j * (thickness + GAP), thickness, xAt(0), xAt(v), true)} fill={seriesColor(j)} opacity={dim} />,
          );
        });
      }
    });
    const tipValue = (i: number) => (stacked ? totals[i]! : values[i]![0]);
    return (
      <div {...common} className="gen-chart">
        {head}
        <div className="gen-chart-plot" ref={ref} onPointerLeave={() => setActive(undefined)}>
          <svg
            width={width}
            height={svgH}
            role="img"
            tabIndex={0}
            aria-label={`${title ? `${title}: ` : ""}${stacked ? "stacked " : ""}horizontal bar chart of ${rows.length} ${rows.length === 1 ? "row" : "rows"}. Arrow keys read each one.`}
            aria-describedby={active === undefined ? undefined : tipId}
            onKeyDown={(e) => {
              if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) {
                e.preventDefault();
                move(e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1);
              } else if (e.key === "Escape") setActive(undefined);
            }}
            onBlur={() => setActive(undefined)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={xAt(t)} x2={xAt(t)} y1={pad.top} y2={pad.top + plotH} className={t === 0 ? "gen-chart-baseline" : "gen-chart-grid"} />
                <text x={xAt(t)} y={svgH - 6} className="gen-chart-tick" textAnchor="middle">
                  {tickFormat.format(t)}
                </text>
              </g>
            ))}
            {rows.map((row, i) => {
              const text = label(row);
              return (
                <text key={i} x={labelW - 8} y={rowTop(i) + rowH / 2} className="gen-chart-tick" textAnchor="end" dominantBaseline="middle">
                  {text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text}
                </text>
              );
            })}
            {bars}
            {shown.length === 1 || stacked
              ? rows.map((_, i) => {
                  const v = tipValue(i);
                  return v === undefined ? null : (
                    <text key={`v${i}`} x={xAt(Math.max(0, v)) + 6} y={rowTop(i) + rowH / 2} className="gen-chart-tick" dominantBaseline="middle">
                      {tickFormat.format(v)}
                    </text>
                  );
                })
              : null}
            {rows.map((_, i) => (
              <rect key={`h${i}`} x={0} y={rowTop(i)} width={width} height={rowH} fill="transparent" onPointerEnter={() => setActive(i)} />
            ))}
          </svg>
          {active === undefined ? null : readout(active, pad.left + plotW / 2, rowTop(active) + rowH)}
        </div>
        {legend}
        {foot}
      </div>
    );
  }
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = Math.max(40, height - PAD.top - PAD.bottom);
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const band = plotW / rows.length;
  const centre = (i: number) => PAD.left + band * (i + 0.5);
  const every = Math.max(1, Math.ceil(56 / band));

  const marks: ReactNode[] = [];
  if (variant === "line") {
    shown.forEach((s, j) => {
      let d = "";
      let pen = false;
      values.forEach((vs, i) => {
        const v = vs[j];
        if (v === undefined) {
          pen = false;
          return;
        }
        d += `${pen ? "L" : "M"}${centre(i)},${y(v)}`;
        pen = true;
      });
      let last = values.length - 1;
      while (last >= 0 && values[last]![j] === undefined) last--;
      marks.push(
        <g key={s.key}>
          <path d={d} fill="none" stroke={seriesColor(j)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {[last, ...(active === undefined || active === last ? [] : [active])]
            .filter((i) => i >= 0 && values[i]![j] !== undefined)
            .map((i) => (
              <circle
                key={i}
                cx={centre(i)}
                cy={y(values[i]![j]!)}
                r={4}
                fill={seriesColor(j)}
                stroke="var(--roer-bg)"
                strokeWidth={2}
              />
            ))}
        </g>,
      );
    });
  } else {
    const groupW = Math.min(band * 0.7, stacked ? MAX_BAR : MAX_BAR * shown.length + GAP * (shown.length - 1));
    const barW = stacked ? groupW : (groupW - GAP * (shown.length - 1)) / shown.length;
    values.forEach((vs, i) => {
      const left = centre(i) - groupW / 2;
      let stack = 0;
      const top = stacked ? vs.map((v, j) => (Math.max(0, v ?? 0) > 0 ? j : -1)).filter((j) => j >= 0).pop() : undefined;
      vs.forEach((v, j) => {
        if (v === undefined) return;
        if (stacked) {
          if (v <= 0) return;
          const base = y(stack);
          stack += v;
          // The gap between segments is taken from the lower one's top.
          const end = y(stack) + (j === top ? 0 : GAP);
          if (base - end <= 0) return;
          marks.push(
            <path
              key={`${i}-${j}`}
              d={columnPath(left, barW, base, end, j === top)}
              fill={seriesColor(j)}
              opacity={active === undefined || active === i ? 1 : 0.55}
            />,
          );
        } else {
          marks.push(
            <path
              key={`${i}-${j}`}
              d={columnPath(left + j * (barW + GAP), barW, y(0), y(v), true)}
              fill={seriesColor(j)}
              opacity={active === undefined || active === i ? 1 : 0.55}
            />,
          );
        }
      });
    });
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      move(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key === "Escape") setActive(undefined);
  };

  const tip = active === undefined ? null : readout(active, centre(active), PAD.top);

  return (
    <div {...common} className="gen-chart">
      {head}
      <div className="gen-chart-plot" ref={ref} onPointerLeave={() => setActive(undefined)}>
        <svg
          width={width}
          height={height}
          role="img"
          tabIndex={0}
          aria-label={`${title ? `${title}: ` : ""}${variant === "line" ? "line" : stacked ? "stacked column" : "column"} chart of ${rows.length} ${rows.length === 1 ? "point" : "points"}. Arrow keys read each one.`}
          aria-describedby={tip ? tipId : undefined}
          onKeyDown={onKey}
          onBlur={() => setActive(undefined)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? "gen-chart-baseline" : "gen-chart-grid"}
              />
              <text x={PAD.left - 6} y={y(t)} className="gen-chart-tick" textAnchor="end" dominantBaseline="middle">
                {tickFormat.format(t)}
              </text>
            </g>
          ))}
          {rows.map((row, i) =>
            i % every === 0 ? (
              <text key={i} x={centre(i)} y={height - 6} className="gen-chart-tick" textAnchor="middle">
                {label(row)}
              </text>
            ) : null,
          )}
          {variant === "line" && active !== undefined ? (
            <line x1={centre(active)} x2={centre(active)} y1={PAD.top} y2={PAD.top + plotH} className="gen-chart-crosshair" />
          ) : null}
          {marks}
          {rows.map((_, i) => (
            <rect
              key={i}
              x={PAD.left + band * i}
              y={PAD.top}
              width={band}
              height={plotH}
              fill="transparent"
              onPointerEnter={() => setActive(i)}
            />
          ))}
        </svg>
        {tip}
      </div>
      {legend}
      {foot}
    </div>
  );
}
