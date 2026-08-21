# AppRail design QA

## Evidence

- Source of truth: `/Users/liangshan/.codex/generated_images/01a024f8-695c-7ff1-b852-da346281088e/exec-d9434cca-16b1-481c-8797-232a1cef9a22.png`
- Implementation capture: `.superpowers/design-qa/app-rail-implementation-52px.png`
- Side-by-side comparison: `.superpowers/brainstorm/80889-1787327820/content/design-qa-comparison.html`
- Viewport: 1440 x 920 CSS pixels on macOS, captured at 2x.
- Image dimensions: source 1568 x 1003 pixels; implementation 2880 x 1840 pixels.

The comparison page normalizes the full-screen images to the same rendered width and provides a second rail-focused comparison at the same rendered height. The source shows the Developer route selected, and the implementation capture uses that same state. Content panes outside `AppRail` are excluded from the visual verdict.

## Visual comparison

- Typography: existing system font stack retained; 9px labels use restrained 560 weight and 680 weight for the selected item. No clipping or unexpected wrapping is visible.
- Layout: the rail stays at the product's existing 52px width. Navigation items remain 44px wide with 60px minimum height and 7px corners, so the polish does not take space from the workbench.
- Color and depth: the restrained `#151b25` rail, muted secondary icons, soft hover surface, and `#273246` selected surface match direction one. The selected state adopts direction three's compact dark tile plus a 2px cobalt edge marker.
- Assets: the existing AutoForge logo artwork, Element Plus route icons, and real account avatar are preserved. The implementation capture also includes the separately confirmed light logo backing from the concurrent logo-contrast task; no approximate replacement artwork was introduced.
- Copy and information architecture: labels, routes, account entry, and logout action are unchanged.
- Interaction states: hover and keyboard focus styling were added without changing RouterLink active-state behavior. The account divider is decorative and hidden from assistive technology.

## Findings and corrections

- Initial comparison found one P1 issue: raw icon components could render at their intrinsic SVG size. The icons are now wrapped by the shared Element Plus icon container and constrained to 18px; the post-fix capture confirms consistent sizing.
- An intermediate 64px treatment was rejected during QA because it reduced the existing workbench area. The final implementation restores the product's 52px rail contract.
- The generated reference uses a wider conceptual rail and a code-chevron glyph for Developer. The implementation intentionally keeps the existing product width and functional icon mapping; these are product constraints, not unresolved design defects.
- The final integrated capture includes a light logo backing added by a separately confirmed, concurrent product task. It is outside this menu-state comparison and does not alter the navigation layout or selected-state verdict.
- Remaining P0/P1/P2 issues: none.

## Verification scope

- Automated checks cover the decorative divider semantics, fixed icon wrapper, route rendering, account state, and logout behavior.
- Runtime capture verifies the selected Developer state at the target desktop viewport with DevTools closed.

final result: passed
