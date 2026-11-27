# Product

Catches instructions hidden in a document before an agent follows them.
It reads PDF, DOCX, HTML, and text the way an extractor does, then asks
whether a person could see each piece of text and whether it is worded as
an instruction to a model.

It flags low-contrast text (WCAG contrast below 1.25:1 and CIE76 difference
below 20), text under 2pt, off-page glyphs, PDF render modes 3 and 7,
opacity at or below 10%, hidden optional-content groups, text covered by a
later opaque shape, clipped text, DOCX `w:vanish`, HTML `display:none` and
zero-size boxes, metadata and annotation payloads, invisible Unicode, and
ten instruction phrases.

Severity of hidden text follows the content: high when it instructs a model,
medium when it contains words, low when it has no words. Visible quoted
attacks stay below the default `high` gate. `--fail-on medium` also blocks
hidden text that is not an instruction.

No network calls, no API key, no model. Node 22.13 or newer.
