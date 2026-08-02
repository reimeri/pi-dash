# UI Style Guide

## Direction

- Keep the interface minimal, restrained, and functional.
- Support a dark theme only.
- Use the generated shadcn-svelte preset and its semantic design tokens as the application design system.
- Use Hugeicons through `@hugeicons/svelte` and `@hugeicons/core-free-icons`.

## Component rules

- Use an existing shadcn-svelte component before creating styled application markup.
- Compose application-specific components from shadcn primitives; do not recreate primitive visuals or behavior.
- Prefer built-in component variants and semantic tokens over custom colors or visual overrides.
- Use Tailwind classes for layout, sizing, and responsive composition—not to replace component colors or typography.
- Use `Field` composition for forms, `Alert` for callouts, `Empty` for empty states, `Badge` for statuses, and `Spinner` for pending states.
- Icons in buttons use `data-icon="inline-start"` or `data-icon="inline-end"`; icon-only controls require an accessible label.

## Visual guidelines

- Prefer simple layouts with strong hierarchy and ample breathing room.
- Reserve destructive styling for errors, blocked states, and destructive actions.
- Avoid gradients, decorative effects, excessive shadows, visual clutter, and unnecessary animation.
- Keep focus, hover, active, disabled, loading, and error states accessible and understated.
- Never rely on color alone to communicate status.

## CSS boundary

- Global CSS contains Tailwind imports, preset variables, and generated base styles only.
- Narrowly scoped CSS is permitted only for third-party integration that utilities cannot express, currently xterm descendant sizing.
- Xterm runtime theme values are isolated from the application design system.
