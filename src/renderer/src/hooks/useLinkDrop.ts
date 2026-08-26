import { useEffect, useState } from 'react'
import { useApp } from '../store/app'
import { looksLikeUrl } from '../lib/format'

/**
 * Accepts a link dragged onto the window.
 *
 * The preventDefault calls are not optional: without them Electron treats a
 * dropped link as a navigation and replaces the whole app with that page.
 * Listening in the capture phase makes sure we win regardless of what any
 * child element does.
 */
export function useLinkDrop(): boolean {
  const [dragging, setDragging] = useState(false)
  const openSheet = useApp((s) => s.openSheet)

  useEffect(() => {
    // Tracks nested enter/leave pairs so moving over a child does not flicker.
    let depth = 0

    const onDragEnter = (event: DragEvent) => {
      event.preventDefault()
      depth++
      setDragging(true)
    }

    const onDragOver = (event: DragEvent) => {
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (event: DragEvent) => {
      event.preventDefault()
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }

    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      depth = 0
      setDragging(false)

      const data = event.dataTransfer
      if (!data) return

      // uri-list is what browsers use when you drag a link or a tab.
      const raw = data.getData('text/uri-list') || data.getData('text/plain')
      const candidate = raw
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('#'))

      if (!candidate || !looksLikeUrl(candidate)) return

      // Dropping a link is an explicit "download this", so it goes straight to
      // the sheet rather than only filling the field in.
      openSheet(candidate)
    }

    window.addEventListener('dragenter', onDragEnter, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('drop', onDrop, true)

    return () => {
      window.removeEventListener('dragenter', onDragEnter, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [openSheet])

  return dragging
}
