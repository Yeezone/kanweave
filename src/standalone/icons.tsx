/**
 * Inline SVG icon set.
 *
 * Everything is a 16×16 stroke icon drawn with `currentColor`, so an icon
 * simply inherits the text colour of whatever button or label contains it.
 * Icons are decorative by default (`aria-hidden`); interactive controls carry
 * their own `aria-label`.
 */
import type { SVGProps } from 'react'

export interface IconProps extends SVGProps<SVGSVGElement> {
  /** Rendered square size, defaults to 16. */
  size?: number
}

function baseProps(props: IconProps): SVGProps<SVGSVGElement> {
  const { size = 16, ...rest } = props
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    ...rest,
  }
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M4 6.25 8 10l4-3.75" />
    </svg>
  )
}

export function IconChevronLeft(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
  )
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

export function IconClose(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  )
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M3 8.5l3.2 3.2L13 5" />
    </svg>
  )
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2 14 14" />
    </svg>
  )
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.4a1 1 0 0 0 1 .95h4.3a1 1 0 0 0 1-.95l.6-8.4" />
      <path d="M6.75 6.75v4M9.25 6.75v4" />
    </svg>
  )
}

export function IconSettings(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.06 1.06M11.34 11.34l1.06 1.06M12.4 3.6l-1.06 1.06M4.66 11.34 3.6 12.4" />
    </svg>
  )
}

export function IconUsers(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.75 13.5c0-2.35 1.9-3.75 4.25-3.75s4.25 1.4 4.25 3.75" />
      <path d="M10.75 3.35a2.5 2.5 0 0 1 0 4.3M12.4 9.95c1.2.55 1.85 1.6 1.85 3.05" />
    </svg>
  )
}

export function IconClock(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  )
}

export function IconUpload(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M8 10.75V2.5M4.75 5.75 8 2.5l3.25 3.25" />
      <path d="M2.75 10.5v2a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-2" />
    </svg>
  )
}

export function IconDownload(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M8 2.5v8.25M4.75 7.5 8 10.75l3.25-3.25" />
      <path d="M2.75 10.5v2a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-2" />
    </svg>
  )
}

export function IconFile(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.25L9 1.75Z" />
      <path d="M9 1.75v3.5h3.5M5.75 8.5h4.5M5.75 11h4.5" />
    </svg>
  )
}

export function IconFileText(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.25L9 1.75Z" />
      <path d="M9 1.75v3.5h3.5" />
      <path d="M5.5 8.5h1M8 8.5h2.5M5.5 11h1M8 11h2.5" />
    </svg>
  )
}

export function IconImage(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="2" y="2.75" width="12" height="10.5" rx="1" />
      <circle cx="5.75" cy="6.25" r="1.05" />
      <path d="m2.25 11.5 3.5-3.25 2.75 2.5 2.4-1.9 2.85 2.4" />
    </svg>
  )
}

export function IconVideo(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="1.75" y="3.5" width="9" height="9" rx="1" />
      <path d="m10.75 6.75 3.5-2v6.5l-3.5-2" />
    </svg>
  )
}

export function IconPaperclip(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="m12.9 7.1-4.6 4.6a3 3 0 0 1-4.24-4.24l5.3-5.3a2 2 0 0 1 2.83 2.83l-5.3 5.3a1 1 0 0 1-1.42-1.42l4.6-4.6" />
    </svg>
  )
}

export function IconComment(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M13.75 9.5a1.75 1.75 0 0 1-1.75 1.75H6.5L3 14V4.25c0-.97.78-1.75 1.75-1.75h7.25c.97 0 1.75.78 1.75 1.75V9.5Z" />
    </svg>
  )
}

export function IconSend(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M13.75 2.5 2.5 6.75l4.5 2.25 2.25 4.5 4.5-11Z" />
      <path d="M7 9 13.75 2.5" />
    </svg>
  )
}

export function IconGrip(props: IconProps) {
  return (
    <svg {...baseProps(props)} stroke="none" fill="currentColor">
      <circle cx="6" cy="4" r="1" />
      <circle cx="10" cy="4" r="1" />
      <circle cx="6" cy="8" r="1" />
      <circle cx="10" cy="8" r="1" />
      <circle cx="6" cy="12" r="1" />
      <circle cx="10" cy="12" r="1" />
    </svg>
  )
}

export function IconCopy(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  )
}

export function IconLink(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M6.9 9.1a2.75 2.75 0 0 0 3.9 0l1.9-1.9a2.75 2.75 0 0 0-3.9-3.9l-.9.9" />
      <path d="M9.1 6.9a2.75 2.75 0 0 0-3.9 0l-1.9 1.9a2.75 2.75 0 0 0 3.9 3.9l.9-.9" />
    </svg>
  )
}

export function IconArchive(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="2" y="2.75" width="12" height="3" rx="0.75" />
      <path d="M3 5.75v7a.75.75 0 0 0 .75.75h8.5a.75.75 0 0 0 .75-.75v-7" />
      <path d="M6.5 8.75h3" />
    </svg>
  )
}

export function IconEdit(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M10.75 2.5 13.5 5.25 6 12.75l-3.5.75.75-3.5 6.5-7.5Z" />
      <path d="m9.5 3.75 2.75 2.75" />
    </svg>
  )
}

export function IconLogout(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3" />
      <path d="M10.5 11 13.5 8l-3-3M13.5 8H6.5" />
    </svg>
  )
}

export function IconBoard(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="2" y="2.75" width="3.5" height="10.5" rx="0.75" />
      <rect x="6.25" y="2.75" width="3.5" height="7" rx="0.75" />
      <rect x="10.5" y="2.75" width="3.5" height="9" rx="0.75" />
    </svg>
  )
}

export function IconFolder(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M2 4.25c0-.55.45-1 1-1h3.1l1.4 1.6H13c.55 0 1 .45 1 1v6.9c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1V4.25Z" />
    </svg>
  )
}

export function IconLock(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <rect x="3.25" y="7" width="9.5" height="6.75" rx="1" />
      <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  )
}

export function IconAlert(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M8 2.25 14.25 13.5H1.75L8 2.25Z" />
      <path d="M8 6.25v3.25M8 11.5v.5" />
    </svg>
  )
}

export function IconInbox(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M2 9.25 3.4 3.5h9.2L14 9.25V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9.25Z" />
      <path d="M2 9.25h3l.75 1.5h4.5l.75-1.5h3" />
    </svg>
  )
}

export function IconRefresh(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M13 8a5 5 0 1 1-1.5-3.55" />
      <path d="M13.25 2.5v3h-3" />
    </svg>
  )
}
