export function wirePointer(canvas, renderer, on) {
  let drag = null

  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: false }
    canvas.setPointerCapture(e.pointerId)
    renderer.setDragging(true)
  })

  canvas.addEventListener('pointermove', (e) => {
    if (drag !== null) {
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (drag.moved || Math.abs(dx) + Math.abs(dy) > 5) {
        drag.moved = true
        renderer.dragBy(dx, dy)
        drag.x = e.clientX
        drag.y = e.clientY
        return
      }
    }
    if (e.pointerType !== 'mouse') return
    const r = renderer.pickRegion(e.clientX, e.clientY)
    on.hover(r)
    canvas.style.cursor = r >= 0 ? 'pointer' : 'grab'
  })

  canvas.addEventListener('pointerup', (e) => {
    const d = drag
    drag = null
    renderer.setDragging(false)
    if (d === null || d.moved) return
    const r = renderer.pickRegion(e.clientX, e.clientY)
    if (r >= 0) on.openRegion(r)
  })

  canvas.addEventListener('pointercancel', () => { drag = null; renderer.setDragging(false) })
  canvas.addEventListener('pointerleave', () => { if (drag === null) on.hover(-1) })
}
