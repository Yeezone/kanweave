/**
 * Pure core helpers: the Markdown renderer must stay XSS-safe and the media
 * allow-list must reject executable payloads before any file hits the disk.
 */
import { describe, expect, it } from 'vitest'

import { isAllowedExtension, kindOfExtension, resolveMime } from '../src/core/media-kind.ts'
import { escapeHtml, renderMarkdown } from '../src/core/markdown.ts'

describe('markdown rendering', () => {
  it('escapes HTML before adding any markup', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> & <b>x</b>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&amp;')
  })

  it('refuses javascript: links but keeps https ones', () => {
    const html = renderMarkdown('[ok](https://example.com) [bad](javascript:alert(1))')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).not.toContain('href="javascript:')
  })

  it('renders headings, lists, task markers and code fences', () => {
    const html = renderMarkdown(['# 标题', '', '- [x] 完成', '- 待办', '', '```ts', 'const a = 1', '```'].join('\n'))
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<input type="checkbox" disabled checked />')
    expect(html).toContain('<code class="language-ts">const a = 1</code>')
  })

  it('keeps paragraphs and line breaks', () => {
    const html = renderMarkdown('第一行\n第二行\n\n第二段')
    expect(html).toBe('<p>第一行<br />第二行</p>\n<p>第二段</p>')
  })

  it('escapes quotes so attributes cannot be broken out of', () => {
    expect(escapeHtml(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;')
  })
})

describe('media allow-list', () => {
  it('accepts images, video and documents', () => {
    for (const name of ['a.png', 'clip.mp4', 'voice.m4a', 'spec.pdf', 'notes.md', 'sheet.xlsx']) {
      expect(isAllowedExtension(name)).toBe(true)
    }
  })

  it('rejects executable payloads', () => {
    for (const name of ['evil.exe', 'evil.bat', 'evil.ps1', 'evil.jar', 'evil.sh']) {
      expect(isAllowedExtension(name)).toBe(false)
    }
  })

  it('classifies kinds by extension', () => {
    expect(kindOfExtension('a.PNG')).toBe('image')
    expect(kindOfExtension('clip.webm')).toBe('video')
    expect(kindOfExtension('voice.mp3')).toBe('audio')
    expect(kindOfExtension('unknown.bin')).toBe('other')
  })

  it('falls back to a safe default mime', () => {
    expect(resolveMime('a.png', null)).toContain('image/png')
    expect(resolveMime('a.bin', null)).toBe('application/octet-stream')
    // A declared generic type must not override a known extension.
    expect(resolveMime('a.png', 'application/octet-stream')).toContain('image/png')
  })
})
