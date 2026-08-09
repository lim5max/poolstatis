# Web color policy

Poolstatis Web uses one lime brand family for interactive green states.

- `primary` / `brand` is the bright lime used for CTA fills, progress, selected tints, and the completed connection flow.
- `brand-strong` is the accessible darker (light theme) or lighter (dark theme) member of the same hue family. It is reserved for semantic status and selected borders/markers, where bright lime would not meet contrast requirements.
- Keyboard focus, text selection, neutral links, and generic status messages use neutral gray tokens. Brand lime is not a default interaction chrome color.
- `success` aliases `brand-lime-strong`. Success may be quieter than a CTA, but it must not introduce another green hue.
- `accent` remains a low-emphasis hover surface. It does not represent success.
- `info` remains blue so informational messages are not confused with success.

`ProductConnectionGuide` is a deliberate primary-state exception to semantic success styling: **Event received** stays `border-primary/50 bg-primary/10`, and its icon stays `bg-primary`.

## Deliberate color exceptions

These colors carry content or third-party identity and must not be remapped to interface state tokens:

- Chart series in `src/index.css`, including `chart-1-stroke` and the forest-green `chart-2`, remain distinct so adjacent series are readable.
- Metric category colors in `src/index.css`, including the green Activation category, remain categorical data colors.
- User-defined metric category colors rendered by `components/metric-categories.tsx` remain inline because the color is stored product data.
- Syntax/data visualization color mixing in `analysis/charts.tsx` remains derived from chart tokens.
- The Windsurf logo keeps its official green. Other integration logos keep their official colors.
- `public/poolstatis-logo.svg` is a static favicon/image asset and cannot consume CSS variables; its fill is pinned to the light-theme primary lime.
- The green metric-taxonomy fixture represents a valid user-supplied category color, not an interface state.

`src/greenColorPolicy.test.ts` rejects Tailwind emerald/green/lime utilities (including arbitrary named colors), raw color functions, inline named greens, and new raw green hex values outside `src/index.css`. Its exception allowlist is exact by file, value, and occurrence count.
