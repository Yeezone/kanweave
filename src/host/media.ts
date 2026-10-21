/**
 * Blob storage for card attachments.
 *
 * Files live outside the database under `<dataDir>/media/<slot>`, where a slot
 * is `<2-char shard>/<id>`. Uploads are streamed to `<slot>.part` and promoted
 * on completion, so a torn upload can never be served as a valid attachment.
 *
 * Uploads support two shapes:
 *  - single request (body = whole file), and
 *  - chunked: `uploadId` + `index` + `last`, appended in order to the same
 *    `.part` file. This is what the browser uses for >8 MiB videos.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { IncomingMessage } from 'node:http'

import { ERROR_CODES } from '../core/protocol.ts'
import { HttpError } from './http.ts'

export interface MediaFileInfo {
  size: number
  path: string
}

/** Detected container MIME from the first bytes of a file. */
export function sniffMime(head: Buffer): string | null {
  if (head.byteLength >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.byteLength >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.byteLength >= 6 && head.toString('latin1', 0, 6) === 'GIF87a') return 'image/gif'
  if (head.byteLength >= 6 && head.toString('latin1', 0, 6) === 'GIF89a') return 'image/gif'
  if (
    head.byteLength >= 12 &&
    head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (head.byteLength >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
    const brand = head.toString('latin1', 8, 12)
    if (brand.startsWith('qt')) return 'video/quicktime'
    return 'video/mp4'
  }
  if (head.byteLength >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return 'video/webm'
  }
  if (head.byteLength >= 4 && head.toString('latin1', 0, 4) === 'OggS') return 'application/ogg'
  if (head.byteLength >= 5 && head.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf'
  if (head.byteLength >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) {
    return 'application/zip'
  }
  return null
}

/** Family of a MIME type, used to reject a container that lies about itself. */
function mimeFamily(mime: string): string {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf' || mime.startsWith('application/zip')) return 'document'
  if (mime === 'application/ogg') return 'audio'
  return 'other'
}

export class MediaStore {
  readonly root: string

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'media')
  }

  /** Create the media root (idempotent). */
  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  slotFor(id: string): string {
    const shard = id.slice(0, 2) || '00'
    return `${shard}/${id}`
  }

  pathFor(slot: string): string {
    const target = resolve(this.root, slot)
    const rootPrefix = this.root.endsWith(sep) ? this.root : this.root + sep
    if (target !== this.root && !target.startsWith(rootPrefix)) {
      throw new HttpError(ERROR_CODES.badRequest, '非法的存储路径')
    }
    return target
  }

  partPathFor(slot: string): string {
    return `${this.pathFor(slot)}.part`
  }

  async info(slot: string): Promise<MediaFileInfo | null> {
    try {
      const file = this.pathFor(slot)
      const stats = await stat(file)
      return stats.isFile() ? { size: stats.size, path: file } : null
    } catch {
      return null
    }
  }

  async partSize(slot: string): Promise<number> {
    try {
      const stats = await stat(this.partPathFor(slot))
      return stats.size
    } catch {
      return 0
    }
  }

  /** Append the request body to `<slot>.part`; returns bytes written. */
  async appendBody(slot: string, req: IncomingMessage, limitBytes: number): Promise<number> {
    const partPath = this.partPathFor(slot)
    await mkdir(dirname(partPath), { recursive: true })
    const existing = await this.partSize(slot)
    const writable = createWriteStream(partPath, { flags: existing > 0 ? 'a' : 'w' })
    let written = 0
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
        written += buffer.byteLength
        if (existing + written > limitBytes) {
          throw new HttpError(ERROR_CODES.tooLarge, '附件超过单文件大小上限')
        }
        if (!writable.write(buffer)) {
          await new Promise<void>((resolveDrain) => writable.once('drain', () => resolveDrain()))
        }
      }
      await new Promise<void>((resolveEnd, rejectEnd) => {
        writable.end(() => resolveEnd())
        writable.once('error', rejectEnd)
      })
      return written
    } catch (error) {
      writable.destroy()
      throw error
    }
  }

  /** Read the first `length` bytes of a partial or final file. */
  async readHead(path: string, length = 64): Promise<Buffer> {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  /** Validate the container against the declared type and promote the file. */
  async finalise(slot: string, declaredMime: string): Promise<{ size: number; mime: string }> {
    const partPath = this.partPathFor(slot)
    const head = await this.readHead(partPath)
    const detected = sniffMime(head)
    if (detected) {
      const declared = mimeFamily(declaredMime)
      const actual = mimeFamily(detected)
      if (declared !== 'other' && declared !== actual) {
        await rm(partPath, { force: true })
        throw new HttpError(
          ERROR_CODES.unsupportedMedia,
          `文件内容与扩展名不符（检测到 ${detected}）`,
        )
      }
    }
    const finalPath = this.pathFor(slot)
    const stats = await stat(partPath)
    await rename(partPath, finalPath)
    return { size: stats.size, mime: declaredMime }
  }

  /** Serve a stored blob with HTTP range support (video seeking). */
  openStream(slot: string, range: { start: number; end: number }): NodeJS.ReadableStream {
    return createReadStream(this.pathFor(slot), { start: range.start, end: range.end })
  }

  async remove(slot: string): Promise<void> {
    await rm(this.pathFor(slot), { force: true })
    await rm(this.partPathFor(slot), { force: true })
  }

  /** Full read used by tests and the cover-thumbnail-less preview path. */
  async read(slot: string): Promise<Buffer> {
    return readFile(this.pathFor(slot))
  }
}
