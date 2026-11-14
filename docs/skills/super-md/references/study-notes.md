# Exam-ready study notes

## Establish only what is missing

Infer the course, learner level, source folder, exam and output format from the request and available materials. Ask at most 1–3 useful questions together: exact exam coverage, whether separate tutorial solutions are needed, desired depth or an unresolved convention. Do not ask for information already supplied or ask the user to repeat a long prompt. Continue source inventory while waiting. Do not turn an example old prompt into a new assignment without checking.

Default to clear, self-contained notes of moderate length: enough explanation to reconstruct the taught methods, with no filler or unexplained summary shorthand. Respect explicit Obsidian Markdown versus portable SMD. A user asking for concise notes still needs reasoning, defined symbols and exam-usable methods.

## Coverage and teaching

Use supplied lectures as the syllabus boundary, and tutorials/past papers to calibrate expected question depth. Read sources needed for coverage; honour a supplied course analysis and requests not to reread every slide. Track coverage internally. Do not insert source maps, page references, navigation boxes or drafting labels unless requested. Organize by lecture number and name when supplied. Do not invent exact slide wording from an analysis.

Explain each new idea in this order where useful: purpose → intuition → precise definition/formula and symbols → worked application → interpretation. Give the missing causal step: why a point changes cluster, why a denominator has that value, which parameters a gradient uses, what a direction or prediction means. Maintain sign, variance, indexing, dimensional and probability conventions. Label modelling assumptions and course-specific conventions at the relevant calculation. Avoid promising full marks.

Use the shortest explanation that supports understanding and transfer to the expected problems. Retain a complete derivation when the course or exam requires it. A conceptual subject may need an argument or evidence rather than an artificial numerical example. No unrelated syllabus expansion.

## Formatting that carries information

Use tables for genuinely parallel data: candidate models, train/dev results, input/output states, voting contributions, hyperparameter sweeps, dimensions, class counts and intermediate numerical comparisons. Never compress them into `A:100/81 B:98/91` or long strings of arrows, commas and numbers. Use prose for reasoning; tables should not replace the explanation.

Give one calculation stage per short paragraph or display equation. Use spaces in coordinate lists and after punctuation; keep leading zeros (0.5). Define quantities before using them. Put a space after closing bold markers before a following word. Inspect rendered output for literal **, raw HTML anchors, broken LaTeX, excessive whitespace and giant inline equation chains. Do not bold entire paragraphs.

Use callouts selectively: a key result, convention, common trap, or a question. They should not surround every paragraph. Avoid repetitive banners, “original question”, “worked prompt”, “corresponding solution”, “task 1”, “pass 2” and drafting/process chatter.

## Questions and exam solutions

When separate tutorial solutions are requested, create a separate file. Include every question and subpart, with its full original statement, data, diagrams and restrictions from the source. Do not silently paraphrase an exact-statement request. Inspect the source page when extraction loses a symbol or figure. Keep all requirements inside the question callout:

> [!question] Q1. Short meaningful title
> Full question statement, including givens and every subpart.
>
> | Given quantity | Value |
> |---|---|
> | ... | ... |

**Solution**

Write the direct complete solution: applicable formula/condition, essential substitutions or argument, necessary intermediate steps, and clearly identifiable final answer with units/interpretation. Make it concise enough to write in an exam, while explaining any non-obvious step. Avoid an essay before every answer. Number subparts only when the question has them. Keep added teaching examples distinguishable from original tutorial questions without noisy provenance labels.

## Verify and deliver

Preserve the latest saved/live user edits; snapshot before changes and use revision guards for open Super MD notes. Recompute new arithmetic independently. Check every source question/subpart is included and answerable from the notes, rather than claiming coverage from a question count alone. Inspect representative early/middle/late sections, wide tables, math-heavy answers and every changed diagram at actual reading sizes. Validate embedded paths and the final saved file. A parser passing is not visual verification.

Deliver the complete file(s) and relative assets, not excerpts or a patch. Never replace the complete notes with a short summary. Keep backup, QA and source-coverage bookkeeping outside the student-facing notes.
