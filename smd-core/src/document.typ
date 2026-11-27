#set heading(numbering: none)
#set text(fill: rgb("#202020"))
#show heading: set text(weight: "bold")
// Print hierarchy and whitespace stay distinct even in compact export presets.
#show heading.where(level: 1): set text(size: 1.6em)
#show heading.where(level: 2): set text(size: 1.35em)
#show heading.where(level: 3): set text(size: 1.15em)
#show heading: set block(above: 1.6em, below: .85em)
#show table: set block(above: 1em, below: 1em)
#set list(spacing: .42em, indent: 1.25em, body-indent: .38em)
#set enum(spacing: .42em, indent: 1.25em, body-indent: .38em)
// Allow long cell labels to wrap when generated fractional columns are narrow.
#show table.cell: set text(hyphenate: true)
#show raw: set text(font: "DejaVu Sans Mono", size: .86em)
// Reserve the full height and depth of inline math on consecutive lines.
#show math.equation.where(block: false): set text(top-edge: "bounds", bottom-edge: "bounds")
#show math.equation.where(block: false): equation => context {
  let height = measure(equation).height
  if height > 1.2em.to-absolute() {
    // A zero-width probe below the baseline exposes the equation's ascent.
    // Adjust the edges directly so the equation still wraps as inline math.
    let probe = box(width: 0pt, height: height, baseline: (at: top))
    let ascent = measure(probe + equation).height - height
    let clearance = .2em
    set text(top-edge: ascent + clearance, bottom-edge: -(height - ascent + clearance))
    equation
  } else {
    equation
  }
}
#show link: set text(fill: smd-link)
#show table.cell.where(y: 0): set text(weight: "bold")
#set page(footer: context align(center, text(size: 8pt, fill: rgb("#686868"), counter(page).display())))
// Measure typeset content, then fit its natural width to the page. Equations and
// code remain vectors and selectable text; the UI's zoom cannot affect PDF layout.
#let smd-fit(body) = layout(size => {
  let natural = measure(body)
  if natural.width > size.width and natural.width > 0pt {
    let factor = size.width / natural.width
    scale(x: factor * 100%, y: factor * 100%, reflow: true, body)
  } else {
    body
  }
})
#let smd-tagged-equation(body, tag) = block(width: 100%, breakable: false, layout(size => {
  let tag-box = text(tag)
  let tag-size = measure(tag-box)
  let gap = 12pt
  let eq = math.equation(block: true, body)
  let eq-size = measure(eq)
  let available = calc.max(40pt, size.width - 2 * (tag-size.width + gap))
  if eq-size.width <= available {
    box(width: size.width, {
      align(center, eq)
      place(right + horizon, tag-box)
    })
  } else {
    let max-eq = calc.max(40pt, size.width - tag-size.width - gap)
    let fitted = if eq-size.width > max-eq and eq-size.width > 0pt {
      let factor = max-eq / eq-size.width
      scale(x: factor * 100%, y: factor * 100%, reflow: true, eq)
    } else {
      eq
    }
    grid(
      columns: (1fr, auto),
      column-gutter: gap,
      align: (center + horizon, right + horizon),
      fitted,
      tag-box,
    )
  }
}))
// Highlight each code block once, then fit synthesized lines individually while
// keeping the outer 1.2em row height and breakable pagination across pages.
#let smd-code(code, lang: none) = context {
  let line-height = 1.2em.to-absolute()
  block(width: 100%, breakable: true, fill: smd-code-fill, inset: 8pt, {
    set par(spacing: 0pt, leading: .3em)
    show raw.where(block: true): it => {
      for line in it.lines {
        block(height: line-height, above: 0pt, below: 0pt, smd-fit(line))
      }
    }
    if code != none {
      raw(code, block: true, lang: lang)
    }
  })
}
#let smd-image(src, width: none, zoom: none, format: auto) = layout(size => {
  let pic = image(src, format: format)
  let bounds = measure(pic)
  let base = if width == none {
    if zoom == none {
      if bounds.height > 0pt { 170mm * (bounds.width / bounds.height) } else { size.width }
    } else {
      bounds.width
    }
  } else if type(width) == ratio {
    size.width * width
  } else {
    width
  }
  let target = if zoom == none { base } else { base * zoom }
  image(src, format: format, width: calc.min(size.width, target))
})
// Compact export-only sequence cells: no card chrome or fixed empty stage.
#let smd-step-image(path) = layout(size => {
  let bounds = measure(image(path))
  let width = calc.min(size.width, 90mm * (bounds.width / bounds.height))
  align(center, image(path, width: width))
})
