# Scaffold Component

Create a new Vue component following the project's conventions.

## Usage
`/scaffold-component [FeatureName/ComponentName]`

Example: `/scaffold-component Workout/WorkoutCard`

## Instructions

Given the component path argument, create `app/components/[FeatureName]/[ComponentName].vue`.

If only one name is provided (no slash), use it as both the feature folder and component name.

The component must follow these conventions from CLAUDE.md:

1. **Always use `<script setup lang="ts">`** — never Options API or `<script>` without setup
2. **Define props with a TypeScript interface** and `withDefaults(defineProps<Props>(), {...})`
3. **Define emits with TypeScript** using `defineEmits<{ ... }>()`
4. **Use NuxtUI components first** — check if `<UButton>`, `<UCard>`, `<UModal>`, etc. covers the need before writing custom markup
5. **Semantic NuxtUI v4 tokens only** — `text-default`/`text-muted`/`text-highlighted`, `bg-default`/`bg-muted`/`bg-elevated`, `border-default`/`border-muted`, plus `text-primary` etc. Never a numbered scale (`text-gray-900`) or a raw hex. Note `text-foreground`/`bg-background`/`border-border` are shadcn tokens and do **not** exist in NuxtUI v4
6. **No manual imports** — Nuxt auto-imports `ref`, `computed`, `useFetch`, `useUserSession`, etc.
7. **Mobile-first** — start with base styles, expand with `sm:`, `md:`, `lg:` breakpoints
8. **PascalCase** component name in the filename

After creating the file, output:
- The full file path
- A brief description of any props/emits the user should customize
