#set heading(numbering: none)
#set par(justify: false, leading: 0.72em)
#set table(inset: 5pt, stroke: 0.5pt + luma(82%))
#show table.cell: cell => {
  if cell.y == 0 {
    set text(weight: "semibold")
    set block(fill: luma(94%))
  }
  cell
}
#show raw.where(block: true): code => block(
  fill: luma(96%),
  stroke: 0.5pt + luma(84%),
  radius: 4pt,
  inset: 8pt,
  width: 100%,
  code,
)
#show quote: item => block(
  fill: rgb("#f3f0ff"),
  stroke: (left: 3pt + rgb("#6750a4")),
  radius: 3pt,
  inset: (x: 10pt, y: 7pt),
  width: 100%,
  item.body,
)
