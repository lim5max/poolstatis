import type { ComponentType, SVGProps } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon';
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import ArrowUp01Icon from '@hugeicons/core-free-icons/ArrowUp01Icon';
import ArrowUpDownIcon from '@hugeicons/core-free-icons/ArrowUpDownIcon';
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import HugeCircleIcon from '@hugeicons/core-free-icons/CircleIcon';
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon';
import DashboardSquare01Icon from '@hugeicons/core-free-icons/DashboardSquare01Icon';
import Database02Icon from '@hugeicons/core-free-icons/Database02Icon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import Download01Icon from '@hugeicons/core-free-icons/Download01Icon';
import HugeGithubIcon from '@hugeicons/core-free-icons/GithubIcon';
import GridViewIcon from '@hugeicons/core-free-icons/GridViewIcon';
import LinkSquare02Icon from '@hugeicons/core-free-icons/LinkSquare02Icon';
import ListSettingIcon from '@hugeicons/core-free-icons/ListSettingIcon';
import Loading03Icon from '@hugeicons/core-free-icons/Loading03Icon';
import LockKeyIcon from '@hugeicons/core-free-icons/LockKeyIcon';
import Menu01Icon from '@hugeicons/core-free-icons/Menu01Icon';
import MoreHorizontalIcon from '@hugeicons/core-free-icons/MoreHorizontalIcon';
import PackageIcon from '@hugeicons/core-free-icons/PackageIcon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';
import Setting07Icon from '@hugeicons/core-free-icons/Setting07Icon';
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon';
import Target01Icon from '@hugeicons/core-free-icons/Target01Icon';
import Tick01Icon from '@hugeicons/core-free-icons/Tick01Icon';
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon';
import ViewOffIcon from '@hugeicons/core-free-icons/ViewOffIcon';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: string | number;
  strokeWidth?: string | number;
};

function bold(icon: IconSvgElement): ComponentType<IconProps> {
  const BoldIcon = (props: IconProps) => (
    <HugeiconsIcon icon={icon} color="currentColor" {...props} strokeWidth={2.35} />
  );
  BoldIcon.displayName = 'HugeiconsBoldIcon';
  return BoldIcon;
}

export const Add = bold(Add01Icon);
export const ArrowDown = bold(ArrowDown01Icon);
export const ArrowLeft = bold(ArrowLeft01Icon);
export const ArrowRight = bold(ArrowRight01Icon);
export const ArrowUp = bold(ArrowUp01Icon);
export const Check = bold(Tick01Icon);
export const CheckIcon = Check;
export const ChevronDown = ArrowDown;
export const ChevronDownIcon = ChevronDown;
export const ChevronRight = bold(ArrowRight01Icon);
export const ChevronRightIcon = ChevronRight;
export const ChevronUpIcon = ArrowUp;
export const ChevronsUpDown = bold(ArrowUpDownIcon);
export const CircleIcon = bold(HugeCircleIcon);
export const Copy = bold(Copy01Icon);
export const Database = bold(Database02Icon);
export const Download = bold(Download01Icon);
export const ExternalLink = bold(LinkSquare02Icon);
export const Eye = bold(ViewIcon);
export const EyeOff = bold(ViewOffIcon);
export const GithubIcon = bold(HugeGithubIcon);
export const KeyRound = bold(LockKeyIcon);
export const LayoutGrid = bold(DashboardSquare01Icon);
export const List = bold(ListSettingIcon);
export const Loader2 = bold(Loading03Icon);
export const Menu = bold(Menu01Icon);
export const MoreHorizontal = bold(MoreHorizontalIcon);
export const PackageBox = bold(PackageIcon);
export const Search = bold(Search01Icon);
export const Settings = bold(Settings01Icon);
export const Target = bold(Target01Icon);
export const Trash2 = bold(Delete02Icon);
export const X = bold(Cancel01Icon);
export const XIcon = X;

export const GridView = bold(GridViewIcon);
export const SystemSettings = bold(Setting07Icon);
export type PoolstatisIcon = ComponentType<IconProps>;
