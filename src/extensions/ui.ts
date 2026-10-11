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
  Chart,
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
export type { ChartSeries, ChartVariant, Common, DiagramComment, DiagramFile, DiagramThread, TableColumn, TextVariant, Tone } from "../generative-ui/components";
export type { NoteAction, NoteAnswer } from "../DiffNote";
export type { NewNote } from "../DiffPane";
// Beyond the catalog, the overlays and controls a tab most often needs, with
// shadcn/ui's names and props: what an agent writing React already knows.
// They are Roer's own copies, compiled with Roer's styles, which is why an
// extension takes them from here rather than adding shadcn itself.
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
export { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../components/ui/popover";
export { Switch } from "../components/ui/switch";
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
export { Surface } from "../generative-ui/Surface";
export type { SurfaceProps } from "../generative-ui/Surface";
export type { ResolvedEvent } from "../generative-ui/GenerativeSurface";
export type { Component, DataModel } from "../generative-ui/schema";
