/**
 * A Generative UI surface inside an extension's tab: catalog components and
 * a data model, in the very JSON `show_ui` and `save_ui` take, drawn by the
 * same renderer. The tab owns the data and answers the buttons itself; no
 * agent is involved.
 */
import { useEffect, useState } from "react";

import { GenerativeSurface, type ResolvedEvent } from "./GenerativeSurface";
import { ROER_CATALOG_ID, writePointer, type Component, type DataModel, type JsonPointer } from "./schema";

export interface SurfaceProps {
  /** The surface's components; the one with id "root" is drawn. */
  components: Component[];
  /** Its data model. A new value replaces what inputs have written to it. */
  data?: DataModel;
  /** A Button's `event`, with its context resolved against the data. */
  onAction?: (event: ResolvedEvent) => void;
  /** The data model after an input wrote to it. */
  onDataChange?: (data: DataModel) => void;
  onOpenFile?: (path: string) => void;
}

export function Surface({ components, data, onAction, onDataChange, onOpenFile }: SurfaceProps) {
  const [model, setModel] = useState<DataModel>(data ?? {});
  useEffect(() => setModel(data ?? {}), [data]);

  const surface = {
    catalogId: ROER_CATALOG_ID,
    components: Object.fromEntries(components.map((component) => [component.id, component])),
    sendDataModel: false,
  };
  const setValue = (path: JsonPointer, value: unknown) => {
    const next = writePointer(model, path, value);
    setModel(next);
    onDataChange?.(next);
  };
  return (
    <GenerativeSurface
      surface={surface}
      dataModel={model}
      onSetValue={setValue}
      onAction={(event) => onAction?.(event)}
      onOpenFile={onOpenFile}
    />
  );
}
