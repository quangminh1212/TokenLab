# TokenLab UI design brief

Read this and `.claude/skills/frontend-design/SKILL.md` before changing anything in `web/`.

## Audience and job

Engineers who run several AI coding agents and want to see, at a glance and with trust, how many tokens and how much money those agents used. The primary job is scanning numbers, comparing over time, breaking usage down by agent or model, and filtering fast. Everything runs on localhost; costs are estimates, not billing.

## What is memorable

The trend chart. It leads the dashboard at full width. Everything else is quiet: a single bordered stat strip with hairline dividers, a recent-requests list, and a ruled table. Spend boldness there and nowhere else.

## Tokens (keep, do not replace)

- Colours come from the logo (`web/public/assets/logo.png`): ink #102020 / #101820, teal #188078, white #F8F8F8. Brand teal `--xlab` is #188078 in light and a lifted #3fb5ab in dark; chart and avatar series use the logo-derived tints `--c1..--c6`. Text on the accent uses `--on-accent`.
- (Legacy note) Brand teal `--xlab`. Use it for the primary button, the active nav item, the chart line and the headline cost figure. For small teal text on light backgrounds use `--xlab-text`.
- Surfaces and text come from the existing `--bg`, `--panel`, `--text`, `--text-secondary`, `--muted`, `--border` variables. Light and dark must both work. Never hard-code colours in markup or SVG; use variables.
- Success, warn and error colours mean status only (live, offline, error). Do not tint figures with them.
- Spacing scale: `--s-1..--s-6` (4, 8, 12, 16, 24, 40 px). Radius: `--r-control` 4px for controls and chips, `--r-panel` 8px for panels and tables, 999px only for pills and segmented tracks. One shadow token, `--shadow`.

## Type roles

One system-font family, no webfonts. Headline figure 2rem/700 with tabular numerals. Page title 1.25rem/700. Section title 0.9375rem/650, sentence case. Body 0.875rem. Table figures and axis ticks 0.75 to 0.8125rem, tabular, right-aligned. Hints 0.75rem in `--text-secondary`. Monospace only for model ids and code.

## Avoid these tells

- Tracked ALL-CAPS labels or eyebrows above headings.
- Meta strings joined with middle dots (`A · B · C`), `WORD — fragment` labels, spaced em dashes, `→` on buttons or links.
- Identical rounded cards with the same grey shadow; gradient washes as decoration.
- A big number with a gradient accent as the default hero; coloured number tones that encode nothing.
- Numbered markers on things that are not a sequence; one accent word in a headline.
- Hover lifts, scale on hover, fade-and-slide entrances, page transitions. Motion is allowed only when it answers a click.
- Marketing copy, credits and design notes shown to end users.

## Copy

Plain language, active voice, sentence case. Buttons say what they do and keep that name everywhere (Refresh, Save). Errors say what happened and how to fix it. Empty states tell people what to do next. English throughout; the document language is `en`.

## Quality floor

- Works down to 360px with no horizontal page scroll; segmented controls scroll instead of shrinking type.
- Visible keyboard focus: the global 2px `--xlab` outline. Do not set `outline: none` without an equal replacement.
- Respect `prefers-reduced-motion`.
- Contrast AA in both themes; check small text in teal.
- Tabular numerals and one number and currency format per surface. Loading, empty and error states use `role="status"` regions.
- Do not rename ids, `data-*` attributes or classes that scripts in `web/src/scripts` query. Prefer additive CSS.
