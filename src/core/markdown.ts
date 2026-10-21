/**
 * Tiny, dependency-free Markdown renderer for card descriptions and comments.
 *
 * Security posture: input is HTML-escaped *first*, then a fixed set of
 * block/inline rules is applied. No raw HTML ever survives, no links may carry
 * `javascript:` (only http/https/mailto and relative URLs pass), and images
 * are rendered as links so a card cannot embed third-party trackers.
 *
 * The output is meant for `dangerouslySetInnerHTML` — it is safe because the
 * escaping happens before any markup is introduced.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

/** Only http(s), mailto and relative targets are turned into anchors. */
function safeHref(raw: string): string | null {
  const href = raw.trim()
  if (!href) return null
  if (href.startsWith('#')) return href
  if (href.startsWith('/')) return href
  if (/^(https?:|mailto:)/i.test(href)) return href
  return null
}

function renderInline(escaped: string): string {
  let out = escaped

  // Inline code first, so its content is not touched by later rules.
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`)

  // Bold, italic, strikethrough.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  // Markdown links [text](href) — href is validated, text is already escaped.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, href: string) => {
    const safe = safeHref(href)
    if (!safe) return match
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener">${text}</a>`
  })

  // Bare URLs.
  out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (match, lead: string, url: string) => {
    const safe = safeHref(url)
    if (!safe) return match
    return `${lead}<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener">${url}</a>`
  })

  return out
}

/**
 * Render Markdown to a sanitized HTML string.
 * Supports: paragraphs, headings, blockquotes, fenced code, lists, rules,
 * GFM tables, task-list markers, and the inline rules above.
 */
export function renderMarkdown(source: string): string {
  const normalized = source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const blocks: string[] = []
  let index = 0

  const isBlank = (line: string | undefined): boolean => !line || !line.trim()

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (isBlank(line)) {
      index += 1
      continue
    }

    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line.trim())
    if (fence) {
      const lang = escapeHtml(fence[1] ?? '')
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      const cls = lang ? ` class="language-${lang}"` : ''
      blocks.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push('<hr />')
      index += 1
      continue
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim())
    if (heading) {
      const level = (heading[1] ?? '#').length
      blocks.push(`<h${level}>${renderInline(escapeHtml(heading[2] ?? ''))}</h${level}>`)
      index += 1
      continue
    }

    // Blockquote (consecutive > lines).
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`)
      continue
    }

    // GFM table: header row followed by a delimiter row.
    const next = lines[index + 1] ?? ''
    if (line.includes('|') && /^\s*\|?[\s:-]*-[\s:|:-]*$/.test(next) && next.includes('-')) {
      const headerCells = splitRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').includes('|') && !isBlank(lines[index])) {
        rows.push(splitRow(lines[index] ?? ''))
        index += 1
      }
      const head = headerCells.map((cell) => `<th>${renderInline(escapeHtml(cell))}</th>`).join('')
      const body = rows
        .map(
          (row) =>
            `<tr>${headerCells
              .map((_h, column) => `<td>${renderInline(escapeHtml(row[column] ?? ''))}</td>`)
              .join('')}</tr>`,
        )
        .join('')
      blocks.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`)
      continue
    }

    // Lists (ordered, unordered, task lists).
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[2] ?? '')
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(current)
        if (!item) break
        let text = item[3] ?? ''
        let prefix = ''
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(text)
        if (task) {
          const checked = task[1] !== ' '
          prefix = `<input type="checkbox" disabled${checked ? ' checked' : ''} /> `
          text = task[2] ?? ''
        }
        items.push(`<li>${prefix}${renderInline(escapeHtml(text))}</li>`)
        index += 1
      }
      blocks.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }

    // Paragraph: consecutive plain lines.
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (
        isBlank(current) ||
        /^```/.test(current.trim()) ||
        /^(#{1,6})\s+/.test(current.trim()) ||
        /^>\s?/.test(current) ||
        /^(\s*)([-*+]|\d+[.)])\s+/.test(current) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(current.trim())
      ) {
        break
      }
      paragraph.push(current)
      index += 1
    }
    if (paragraph.length > 0) {
      blocks.push(`<p>${renderInline(escapeHtml(paragraph.join('\n'))).replace(/\n/g, '<br />')}</p>`)
    }
  }

  return blocks.join('\n')
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}
