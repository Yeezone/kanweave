/**
 * Attachment upload widget.
 *
 * Files are uploaded strictly one after another. Small files go up in a single
 * request; files above `limits.chunkBytes` are sliced into segments carrying
 * `uploadId`/`index`/`last`. Uploads use XMLHttpRequest because only that
 * exposes `upload.onprogress`.
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import type { AttachmentView } from '../core/protocol.ts'
import { attachmentUploadUrl, parseUploadSegment, runtimeLimits, uploadSegment } from './api.ts'
import type { ApiFailure } from './api.ts'
import { describeError, formatBytes, useI18n } from './locales.ts'
import { useToast } from './toast.tsx'
import { isAllowedExtension } from '../core/media-kind.ts'
import { IconCheck, IconClose, IconFile, IconUpload } from './icons.tsx'

type UploadStatus = 'queued' | 'uploading' | 'done' | 'error'

interface UploadItem {
  key: string
  filename: string
  size: number
  /** 0…1 */
  progress: number
  status: UploadStatus
  error?: string
}

interface QueuedUpload {
  key: string
  file: File
}

export interface UploaderProps {
  cardId: string
  disabled?: boolean
  multiple?: boolean
  onUploaded: (attachment: AttachmentView) => void
  /** Called with `true` while at least one file is uploading. */
  onBusyChange?: (busy: boolean) => void
}

const DONE_VISIBLE_MS = 2600

export function Uploader({ cardId, disabled, multiple = true, onUploaded, onBusyChange }: UploaderProps) {
  const { t, locale } = useI18n()
  const notify = useToast()
  const limits = runtimeLimits()
  const [items, setItems] = useState<UploadItem[]>([])
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const queueRef = useRef<QueuedUpload[]>([])
  const runningRef = useRef(false)
  const counterRef = useRef(0)
  const uploadsRef = useRef(new Map<string, () => void>())
  const cancelledRef = useRef(new Set<string>())
  const timersRef = useRef(new Set<number>())
  const onUploadedRef = useRef(onUploaded)
  onUploadedRef.current = onUploaded

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current) window.clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [])

  const uploading = items.some((item) => item.status === 'uploading' || item.status === 'queued')
  const busyRef = useRef(false)
  useEffect(() => {
    if (busyRef.current === uploading) return
    busyRef.current = uploading
    if (onBusyChange) onBusyChange(uploading)
  }, [uploading, onBusyChange])

  function patchItem(key: string, patch: Partial<UploadItem>) {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  function removeLater(key: string) {
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer)
      setItems((current) => current.filter((item) => item.key !== key))
    }, DONE_VISIBLE_MS)
    timersRef.current.add(timer)
  }

  function failItem(key: string, failure: ApiFailure) {
    const message = describeError(failure, t)
    patchItem(key, { status: 'error', error: message })
    notify({ kind: 'error', message })
  }

  async function uploadOne(entry: QueuedUpload): Promise<void> {
    const { file, key } = entry
    patchItem(key, { status: 'uploading', progress: 0 })

    // No `AbortController`: XHR exposes an `abort()` handle instead.
    const attempts: Array<{ abort: () => void }> = []
    const track = (abort: () => void) => {
      attempts.push({ abort })
      uploadsRef.current.set(key, abort)
    }

    try {
      if (file.size <= limits.chunkBytes) {
        const url = attachmentUploadUrl({ cardId, filename: file.name, mime: file.type || undefined })
        const handle = uploadSegment(url, file, (progress) => {
          const fraction = progress.total > 0 ? progress.loaded / progress.total : 0
          patchItem(key, { progress: Math.max(0, Math.min(1, fraction)) })
        })
        track(handle.abort)
        const result = await handle.promise
        if (cancelledRef.current.has(key)) return
        if (!result.ok) {
          failItem(key, result)
          return
        }
        const segment = parseUploadSegment(result.value)
        if (!segment.complete || !segment.attachment) {
          failItem(key, { ok: false, code: 'INTERNAL', message: t('upload.incomplete') })
          return
        }
        patchItem(key, { status: 'done', progress: 1 })
        onUploadedRef.current(segment.attachment)
        removeLater(key)
        return
      }

      // Chunked upload: first segment mints the uploadId, then numbered slices.
      let uploadId: string | null = null
      let offset = 0
      let index = 0
      while (offset < file.size) {
        if (cancelledRef.current.has(key)) return
        const end = Math.min(offset + limits.chunkBytes, file.size)
        const last = end >= file.size
        const blob = file.slice(offset, end)
        const url = attachmentUploadUrl({
          cardId,
          filename: file.name,
          mime: index === 0 ? file.type || undefined : undefined,
          uploadId: uploadId ?? undefined,
          index,
          last,
        })
        const handle = uploadSegment(url, blob, (progress) => {
          const within = progress.total > 0 ? progress.loaded / progress.total : 0
          patchItem(key, { progress: Math.max(0, Math.min(1, (offset + within * blob.size) / file.size)) })
        })
        track(handle.abort)
        const result = await handle.promise
        if (cancelledRef.current.has(key)) return
        if (!result.ok) {
          failItem(key, result)
          return
        }
        const segment = parseUploadSegment(result.value)
        if (!uploadId) {
          if (!segment.uploadId) {
            failItem(key, { ok: false, code: 'INTERNAL', message: t('upload.incomplete') })
            return
          }
          uploadId = segment.uploadId
        }
        if (last) {
          if (!segment.complete || !segment.attachment) {
            failItem(key, { ok: false, code: 'INTERNAL', message: t('upload.incomplete') })
            return
          }
          patchItem(key, { status: 'done', progress: 1 })
          onUploadedRef.current(segment.attachment)
          removeLater(key)
          return
        }
        offset = end
        index += 1
      }
    } finally {
      uploadsRef.current.delete(key)
      attempts.length = 0
    }
  }

  async function drain(): Promise<void> {
    if (runningRef.current) return
    runningRef.current = true
    try {
      for (;;) {
        const entry = queueRef.current.shift()
        if (!entry) break
        if (cancelledRef.current.has(entry.key)) continue
        await uploadOne(entry)
      }
    } finally {
      runningRef.current = false
    }
  }

  function enqueue(files: File[]) {
    const accepted: Array<{ item: UploadItem; file: File }> = []
    for (const file of files) {
      if (!isAllowedExtension(file.name)) {
        notify({ kind: 'error', message: t('upload.rejectedType', { name: file.name }) })
        continue
      }
      if (file.size === 0) {
        notify({ kind: 'error', message: t('upload.empty', { name: file.name }) })
        continue
      }
      if (file.size > limits.maxAttachmentBytes) {
        notify({
          kind: 'error',
          message: t('upload.tooLarge', { name: file.name, max: formatBytes(limits.maxAttachmentBytes, locale) }),
        })
        continue
      }
      counterRef.current += 1
      accepted.push({
        file,
        item: {
          key: `upload-${counterRef.current}`,
          filename: file.name,
          size: file.size,
          progress: 0,
          status: 'queued',
        },
      })
    }
    if (accepted.length === 0) return
    setItems((current) => [...current, ...accepted.map((entry) => entry.item)])
    queueRef.current.push(...accepted.map((entry) => ({ key: entry.item.key, file: entry.file })))
    void drain()
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : []
    if (files.length > 0) enqueue(multiple ? files : files.slice(0, 1))
    if (inputRef.current) inputRef.current.value = ''
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (disabled) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragging(false)
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    const files = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : []
    if (files.length > 0) enqueue(multiple ? files : files.slice(0, 1))
  }

  function cancelItem(key: string) {
    cancelledRef.current.add(key)
    const abort = uploadsRef.current.get(key)
    if (abort) abort()
    queueRef.current = queueRef.current.filter((entry) => entry.key !== key)
    setItems((current) => current.filter((item) => item.key !== key))
  }

  return (
    <div className="kw-uploader">
      <div
        className={`kw-dropzone${dragging ? ' kw-dropzone-active' : ''}${disabled ? ' kw-dropzone-disabled' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className="kw-dropzone-icon" aria-hidden="true">
          <IconUpload size={20} />
        </span>
        <p className="kw-dropzone-title">{t('upload.dropHint')}</p>
        <label className={`kw-button kw-button-small${disabled ? ' kw-button-disabled' : ''}`}>
          {t('upload.browse')}
          <input
            ref={inputRef}
            type="file"
            className="kw-visually-hidden"
            multiple={multiple}
            disabled={disabled}
            onChange={onInputChange}
          />
        </label>
        <p className="kw-dropzone-limit kw-muted">
          {t('upload.limit', { max: formatBytes(limits.maxAttachmentBytes, locale) })}
        </p>
      </div>

      {items.length > 0 ? (
        <ul className="kw-upload-list">
          {items.map((item) => (
            <li key={item.key} className="kw-upload-item">
              <span className="kw-upload-file-icon" aria-hidden="true">
                {item.status === 'done' ? <IconCheck /> : <IconFile />}
              </span>
              <div className="kw-upload-item-main">
                <div className="kw-upload-item-head">
                  <span className="kw-upload-name" title={item.filename}>
                    {item.filename}
                  </span>
                  <span className="kw-upload-size kw-muted">{formatBytes(item.size, locale)}</span>
                </div>
                {item.status === 'error' ? (
                  <span className="kw-upload-error">{item.error ?? t('upload.failed')}</span>
                ) : (
                  <div className="kw-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
                    <span
                      className={`kw-progress-bar${item.status === 'done' ? ' kw-progress-bar-done' : ''}`}
                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                className="kw-icon-button kw-upload-dismiss"
                aria-label={item.status === 'error' || item.status === 'done' ? t('common.dismiss') : t('upload.cancel')}
                onClick={() => cancelItem(item.key)}
              >
                <IconClose size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
