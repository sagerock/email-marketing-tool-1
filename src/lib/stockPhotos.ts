// Adobe Stock helpers for the builder's "Stock photos" panel. Adobe's API is
// Enterprise-only, so the panel links to stock.adobe.com searches; the user
// licenses there and drops the downloaded file into the chat.

export type Orientation = 'horizontal' | 'vertical' | 'square' | 'panoramic'

export interface EmailImage {
  alt: string
  src: string
  width: number | null
  height: number | null
  /** Text near the image, so the ideas fit what the email says there. */
  context: string
}

const squash = (text: string | null | undefined) => (text || '').replace(/\s+/g, ' ').trim()

function sizeOf(img: HTMLImageElement, dim: 'width' | 'height'): number | null {
  const attr = parseInt(img.getAttribute(dim) || '', 10)
  if (attr > 0) return attr
  const style = (img.getAttribute('style') || '').match(new RegExp(`(?:^|;)\\s*${dim}\\s*:\\s*(\\d+)px`, 'i'))
  return style ? parseInt(style[1], 10) : null
}

// Nearest enclosing block with some text, up to a few levels out.
function contextOf(img: Element): string {
  let el: Element | null = img.parentElement
  for (let level = 0; el && level < 6; level++, el = el.parentElement) {
    const text = squash(el.textContent)
    if (text.length >= 30) return text.slice(0, 400)
  }
  return ''
}

// The email's images in document order (the same order the preview's
// scanElements sees them, since both skip comments), plus its plain text.
export function emailImages(html: string): { images: EmailImage[]; text: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('style, script, title').forEach(n => n.remove())
  const images = Array.from(doc.querySelectorAll('img')).map(img => ({
    alt: squash(img.getAttribute('alt')),
    src: img.getAttribute('src') || '',
    width: sizeOf(img, 'width'),
    height: sizeOf(img, 'height'),
    context: contextOf(img),
  }))
  return { images, text: squash(doc.body?.textContent).slice(0, 4000) }
}

export function adobeStockUrl(search: string, orientation?: Orientation): string {
  const params = new URLSearchParams({ k: search })
  params.set('filters[content_type:photo]', '1')
  if (orientation) params.set('filters[orientation]', orientation)
  return `https://stock.adobe.com/search/images?${params.toString()}`
}
