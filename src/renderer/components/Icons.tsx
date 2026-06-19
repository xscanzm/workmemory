import React from "react";

/**
 * Icon - 轻量 SVG 图标组件
 * 统一 16x16 视图框，stroke 风格，不依赖外部库
 */
interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}

const baseProps = (size: number, strokeWidth: number, className?: string, style?: React.CSSProperties) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  style,
});

export const PlayIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none" />
  </svg>
);

export const PauseIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
  </svg>
);

export const ShieldIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

export const TrashIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export const SearchIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

export const RefreshIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

export const CheckIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const XIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export const PlusIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const EditIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

export const CopyIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const DownloadIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export const ClockIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

export const StarIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

export const TagIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  </svg>
);

export const SettingsIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const FileTextIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

export const LayoutIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="9" y1="21" x2="9" y2="9" />
  </svg>
);

export const ChevronDownIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export const ChevronRightIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

export const BoldIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
    <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
  </svg>
);

export const ListIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

export const HeadingIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M6 12h12" />
    <path d="M6 20V4" />
    <path d="M18 20V4" />
  </svg>
);

export const CodeIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);

export const AlertIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

export const InfoIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

export const UndoIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

export const HistoryIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M3 3v5h5" />
    <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
    <path d="M12 7v5l4 2" />
  </svg>
);

export const SparklesIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
  </svg>
);

export const FilterIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </svg>
);

export const EyeIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const KeyboardIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" />
  </svg>
);

export const UsersIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export const CalendarIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

export const BookIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);

export const LinkIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

export const BellIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

export const ZapIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

export const TrendingUpIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
    <polyline points="17 6 23 6 23 12" />
  </svg>
);

export const CoffeeIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M18 8h1a4 4 0 0 1 0 8h-1" />
    <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" />
    <line x1="6" y1="1" x2="6" y2="4" />
    <line x1="10" y1="1" x2="10" y2="4" />
    <line x1="14" y1="1" x2="14" y2="4" />
  </svg>
);

export const SaveIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

export const NetworkIcon = ({ size = 16, strokeWidth = 2, className, style }: IconProps) => (
  <svg {...baseProps(size, strokeWidth, className, style)}>
    <circle cx="12" cy="5" r="3" />
    <circle cx="5" cy="19" r="3" />
    <circle cx="19" cy="19" r="3" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="12" x2="7" y2="17" />
    <line x1="12" y1="12" x2="17" y2="17" />
  </svg>
);
