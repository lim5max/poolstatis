import type { ComponentType, SVGProps } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  Add01Icon,
  Alert02Icon,
  BrowserIcon,
  CatalogueIcon,
  ChartAnalysisIcon,
  CircleIcon as HugeCircleIcon,
  Copy01Icon,
  DashboardSquare01Icon,
  DashboardSpeed01Icon,
  Database02Icon,
  Delete02Icon,
  Download01Icon,
  FunnelIcon,
  GitCommitHorizontalIcon,
  GithubIcon as HugeGithubIcon,
  Globe02Icon,
  GridViewIcon,
  LinkSquare02Icon,
  ListSettingIcon,
  LockKeyIcon,
  MoreHorizontalIcon,
  PackageIcon,
  Plug01Icon,
  RulerIcon,
  Setting07Icon,
  Settings01Icon,
  Target01Icon,
  TaskDone01Icon,
  TestTube01Icon,
  Tick01Icon,
  UserCircleIcon,
  UserGroupIcon,
  ViewIcon,
  ViewOffIcon,
} from '@hugeicons-pro/core-solid-rounded';
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import ArrowUp01Icon from '@hugeicons/core-free-icons/ArrowUp01Icon';
import ArrowUpDownIcon from '@hugeicons/core-free-icons/ArrowUpDownIcon';
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import Loading03Icon from '@hugeicons/core-free-icons/Loading03Icon';
import Menu01Icon from '@hugeicons/core-free-icons/Menu01Icon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'strokeWidth'> & {
  size?: string | number;
  strokeWidth?: number;
};

function solid(icon: IconSvgElement): ComponentType<IconProps> {
  const SolidIcon = (props: IconProps) => (
    <HugeiconsIcon icon={icon} color="currentColor" {...props} />
  );
  SolidIcon.displayName = 'HugeiconsSolidIcon';
  return SolidIcon;
}

function stroke(icon: IconSvgElement): ComponentType<IconProps> {
  const StrokeIcon = (props: IconProps) => (
    <HugeiconsIcon icon={icon} color="currentColor" {...props} strokeWidth={2.35} />
  );
  StrokeIcon.displayName = 'HugeiconsStrokeIcon';
  return StrokeIcon;
}

export const Add = solid(Add01Icon);
export const AlertTriangle = solid(Alert02Icon);
export const ArrowDown = stroke(ArrowDown01Icon);
export const ArrowLeft = stroke(ArrowLeft01Icon);
export const ArrowRight = stroke(ArrowRight01Icon);
export const ArrowUp = stroke(ArrowUp01Icon);
export const Browser = solid(BrowserIcon);
export const Catalogue = solid(CatalogueIcon);
export const ChartAnalysis = solid(ChartAnalysisIcon);
export const Check = solid(Tick01Icon);
export const CheckIcon = Check;
export const ChevronDown = ArrowDown;
export const ChevronDownIcon = ChevronDown;
export const ChevronRight = ArrowRight;
export const ChevronRightIcon = ChevronRight;
export const ChevronUpIcon = ArrowUp;
export const ChevronsUpDown = stroke(ArrowUpDownIcon);
export const CircleIcon = solid(HugeCircleIcon);
export const Copy = solid(Copy01Icon);
export const DashboardSpeed = solid(DashboardSpeed01Icon);
export const Database = solid(Database02Icon);
export const Download = solid(Download01Icon);
export const ExternalLink = solid(LinkSquare02Icon);
export const Eye = solid(ViewIcon);
export const EyeOff = solid(ViewOffIcon);
export const GithubIcon = solid(HugeGithubIcon);
export const GitCommit = solid(GitCommitHorizontalIcon);
export const Funnel = solid(FunnelIcon);
export const Globe = solid(Globe02Icon);
export const KeyRound = solid(LockKeyIcon);
export const LayoutGrid = solid(DashboardSquare01Icon);
export const List = solid(ListSettingIcon);
export const Loader2 = stroke(Loading03Icon);
export const Menu = stroke(Menu01Icon);
export const MoreHorizontal = solid(MoreHorizontalIcon);
export const PackageBox = solid(PackageIcon);
export const Plug = solid(Plug01Icon);
export const Ruler = solid(RulerIcon);
export const Search = stroke(Search01Icon);
export const Settings = solid(Settings01Icon);
export const TaskDone = solid(TaskDone01Icon);
export const Target = solid(Target01Icon);
export const TestTube = solid(TestTube01Icon);
export const Trash2 = solid(Delete02Icon);
export const UserCircle = solid(UserCircleIcon);
export const UserGroup = solid(UserGroupIcon);
export const X = stroke(Cancel01Icon);
export const XIcon = X;

export const GridView = solid(GridViewIcon);
export const SystemSettings = solid(Setting07Icon);
export type PoolstatisIcon = ComponentType<IconProps>;
