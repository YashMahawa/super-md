#set heading(numbering: none)
#set text(fill: rgb("#20252d"))
#show heading: set text(weight: "bold")
#show raw: set text(font: "DejaVu Sans Mono", size: .86em)
#show link: set text(fill: rgb("#315d99"))
#set page(footer: context align(center, text(size: 8pt, fill: rgb("#687382"), counter(page).display())))
// Measure typeset content, then fit its natural width to the page. Equations and
// code remain vectors and selectable text; the UI's zoom cannot affect PDF layout.
#let smd-fit(body) = layout(size => {
  let natural = measure(body)
  let factor = if natural.width > 0pt { calc.min(1, size.width / natural.width) } else { 1 }
  scale(x: factor * 100%, y: factor * 100%, reflow: true, body)
})
#let smd-image(path) = layout(size => {
  let pic = image(path)
  let bounds = measure(pic)
  let width = calc.min(size.width, 170mm * (bounds.width / bounds.height))
  image(path, width: width)
})
