# Analytics UI overhaul specification

## Outcome

Poolstatis customer analytics must read like a calm answer, not a configuration surface:

1. The selected period is always visible at the top of an analytics screen.
2. `Today`, `Yesterday`, `7 days`, `30 days`, `90 days`, and an exact custom range are available wherever a time window changes the answer.
3. Valid screens load automatically. A user never has to press `Run answer` to reveal an already-configured result.
4. The first viewport prioritizes result, KPI rail, and chart. Trust, provenance, unsupported capabilities, and methodology are compact secondary details.
5. Buttons and button-like navigation use a full pill radius. Cards use a materially softer large radius. Inputs and selects use a consistent pill treatment.
6. Visible interface copy never relies on tiny type. The minimum visible text size is 15px; body and controls are 16px by default.
7. Repeated footnotes and repeated explanations are removed. Data truth is retained once in a concise `Data details` disclosure when it affects interpretation.
8. Tables remain the primary object on People, Saved, Usage, Definitions, and Events; unavailable capabilities must not take more space than the useful data.
9. Desktop and mobile preserve hierarchy, keyboard access, touch targets, and horizontal containment.

## Visual direction

- Use the existing Geist/STIX/Geist Mono typography roles and lime brand accent.
- Use the supplied Seline reference for a compact period-first overview and the supplied Mixpanel reference for a single compact control rail above a dominant chart.
- Do not clone proprietary branding. Reproduce the information hierarchy, density, period placement, and interaction model inside the existing Poolstatis design system.
- Prefer one containing surface with internal dividers over many equal cards.
- Use pills for actions and controls, not decorative status clutter.

## Shared date semantics

`AnalyticsRangeSelection` is the single UI state for analytics windows:

```ts
type AnalyticsRangePreset = 'today' | 'yesterday' | '7d' | '30d' | '90d';
type AnalyticsRangeSelection =
  | { kind: 'preset'; preset: AnalyticsRangePreset }
  | { kind: 'custom'; from: string; to: string };
```

- Query intervals are half-open UTC intervals `[from, to)`.
- `Today` begins at 00:00 UTC and ends at the current instant; the UI labels this UTC contract explicitly.
- `Yesterday` is the complete previous calendar day.
- Rolling 7/30/90-day presets include the current partial day.
- Custom inputs are inclusive calendar dates in the control, converted to a half-open query ending at the next midnight.
- Comparison is previous equivalent period when an exact non-empty period exists; otherwise the UI says comparison is unavailable and does not invent a delta.
- The selected value is stored in URL search parameters so refresh and sharing preserve the answer.

## Screen requirements

### Home

- Header: title, global period control, optional compare toggle.
- First surface: compact KPI rail, one dominant trend, compact breakdown.
- Open attention items appear below the answer as concise rows, not large narrative cards.
- Setup blockers use one inline action row.

### Web

- Load the overview immediately for the selected period.
- Keep KPI rail, trend, and one breakdown visible without a secondary `Load` action.
- Tabs change the breakdown below the chart; unavailable tabs render one concise empty state.

### Product and Funnels

- Template choice is a compact segmented/tab control.
- The chosen answer runs automatically when the template, metric, funnel, period, or breakdown changes.
- Loading preserves the chart canvas with a skeleton.
- Saving and official status actions are secondary to the chart.

### People and Person

- One compact toolbar contains search, period, queue, order, and activity.
- The table removes the dedicated repeated `Order evidence` column. Ordering context appears once above the table; row-level activation evidence appears only for an activation queue.
- Data limitations become one concise `Data details` disclosure below the table.
- IDs and event names may use mono, but never smaller than 15px.

### Saved, Ship, Usage, Setup, Definitions, Events, Experience, Keys, Profile

- Inherit the same type, radius, control, surface, spacing, and disclosure rules.
- Remove repeated explanatory copy where the heading/action already communicates the same thing.
- Keep safety-critical, privacy, destructive-action, and server-truth copy; make it concise and place it next to the affected action.

## Verification contract

- Unit/integration tests prove date conversion, URL persistence, autorun, and screen query payloads.
- Browser E2E uses the disposable PostgreSQL contract, a real Fastify instance, and a real Vite build/dev server.
- E2E covers Home, Web, Product, Funnels, People, Saved, Ship, Usage, and Setup at 1440x900 and 390x844.
- E2E asserts no horizontal overflow, no `Run answer`, visible `Today` and `Custom`, pill actions, large card radii, readable computed font sizes, and zero console/page errors.
- Full Core/Web/SDK/MCP/self-host gates run before integration. Production deployment remains separate from merge and requires backup, rollback, immutable SHA, and live read-back.
