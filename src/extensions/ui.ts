/**
 * `roer/ui`: the Generative UI catalog as React components, so an
 * extension's tab is built from the same pieces as a surface an agent draws,
 * and looks and behaves the same. `Surface` draws catalog JSON itself.
 */
export {
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
  statusTone,
} from "../generative-ui/components";
export type { Common, DiagramComment, DiagramFile, DiagramThread, TableColumn, TextVariant, Tone } from "../generative-ui/components";
export type { NoteAction, NoteAnswer } from "../DiffNote";
export type { NewNote } from "../DiffPane";
export { Surface } from "../generative-ui/Surface";
export type { SurfaceProps } from "../generative-ui/Surface";
export type { ResolvedEvent } from "../generative-ui/GenerativeSurface";
export type { Component, DataModel } from "../generative-ui/schema";
