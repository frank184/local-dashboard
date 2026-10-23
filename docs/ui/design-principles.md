# UI design principles

These principles capture the direction established while shaping the Calendar and the wider local dashboard.

## Layout

- Prefer a fluid workspace canvas over a centered, narrow application container.
- Use persistent side rails for navigation and contextual tools. Panels should feel like part of the workspace, not stacks of floating cards.
- Keep borders and background changes quiet. Use them to clarify hierarchy and scrolling, not to outline every region.
- Let the primary work surface take the space it needs. Calendar is a wide, continuous canvas with a compact left calendar rail and a contextual right rail.
- At smaller widths, progressively contract rails and controls, then hide or collapse lower-priority panels before forcing the main content into an unusable width.
- Give each page a clear scroll owner. Calendar's hourly grid scrolls inside its board; its day header and all-day lane remain pinned while timed events pass underneath.
- Hide scrollbars when the interaction remains discoverable and usable through wheel, trackpad, touch, or keyboard input. Do not remove the scrolling behavior itself.

## Calendar

- Keep the all-day lane directly below the day header and above the timed grid.
- All-day events are date-based and do not require start or end times. Render them as compact, readable colored chips.
- Keep the all-day lane pinned while the hourly schedule scrolls. A subtle edge fade may clarify that content moves beneath the lane; keep the gradient static unless motion adds clear value.
- Calendar event text should remain legible at normal desktop scale. Avoid shrinking titles and time labels merely to fit more decoration into a cell.
- Keep calendar settings on the Calendar plugin's settings page, reachable from the plugin surface.

## Plugin consistency

- A plugin owns its product page and its settings. Link settings from the plugin surface and route them through the plugin page/settings convention.
- Integrations own provider authorization and synchronization. Plugins consume normalized local data and provide user-facing capabilities.
- Shared navigation and page chrome should remain consistent; a plugin can customize its workspace content without inventing a separate application shell.

## Motion

- Motion should feel quick and purposeful. Prefer short transitions and avoid movement that delays task completion.
- **Never use exponential easing for fade-outs.** When an opacity fade-out is needed, use a logarithmic decay: opacity should drop quickly at first, then settle toward zero. Avoid a long, slow visible tail.
- Do not label generic `ease-out` or cubic ease-out curves as logarithmic. Use a verified logarithmic opacity curve or a piecewise CSS `linear()` timing function that approximates one. If that curve is not available, use no opacity animation.
- Respect `prefers-reduced-motion`; remove nonessential transitions and animated scrolling when it is enabled.
- A spatial gradient, such as the static fade below Calendar's all-day lane, is not an opacity animation and does not require temporal easing.
