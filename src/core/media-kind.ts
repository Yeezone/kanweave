/**
 * Attachment classification shared by the host (validation, sniffing) and the
 * UI (icons, previews, which card renders inline).
 *
 * SVG is deliberately *not* an inline image: it can carry script, so it is
 * served as a download-only document.
 */
import type { AttachmentKind } from './protocol.ts'

interface KindSpec {
  kind: AttachmentKind
  extensions: readonly string[]
  /** Preferred MIME types when the browser did not send one. */
  mimes: readonly string[]
}

const SPECS: readonly KindSpec[] = [
  {
    kind: 'image',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'],
    mimes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'],
  },
  {
    kind: 'video',
    extensions: ['mp4', 'm4v', 'webm', 'mov', 'ogv', 'mkv'],
    mimes: ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg', 'video/x-matroska'],
  },
  {
    kind: 'audio',
    extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
    mimes: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac'],
  },
  {
    kind: 'document',
    extensions: [
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md',
      'csv', 'json', 'xml', 'yaml', 'yml', 'svg', 'zip', '7z', 'rar', 'gz',
      'tar', 'log', 'sql',
    ],
    mimes: ['application/pdf', 'application/json', 'application/zip', 'text/plain', 'image/svg+xml'],
  },
]

/** Extension allow-list, derived from SPECS. */
export const ALLOWED_EXTENSIONS: readonly string[] = SPECS.flatMap((spec) => spec.extensions)

/** Default MIME lookup for well-known extensions. */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  log: 'text/plain',
  sql: 'application/sql',
}

/** Lower-case file extension without the dot ('' when absent). */
export function extensionOf(filename: string): string {
  const clean = filename.split(/[?#]/, 1)[0] ?? filename
  const dot = clean.lastIndexOf('.')
  return dot > 0 && dot < clean.length - 1 ? clean.slice(dot + 1).toLowerCase() : ''
}

/** True when the extension is on the allow-list. */
export function isAllowedExtension(filename: string): boolean {
  return ALLOWED_EXTENSIONS.includes(extensionOf(filename))
}

/** Classify by extension only — MIME from the browser is advisory. */
export function kindOfExtension(filename: string): AttachmentKind {
  const ext = extensionOf(filename)
  for (const spec of SPECS) {
    if (spec.extensions.includes(ext)) return spec.kind
  }
  return 'other'
}

/** Effective MIME: trust the sniffed/content type when it agrees, else derive. */
export function resolveMime(filename: string, contentType?: string | null): string {
  const ext = extensionOf(filename)
  const provider = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (provider && provider !== 'application/octet-stream' && provider.includes('/')) {
    return provider
  }
  return EXT_MIME[ext] ?? 'application/octet-stream'
}

/** Display name for a card's cover: the first image attachment. */
export function isInlineRenderable(kind: AttachmentKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}
