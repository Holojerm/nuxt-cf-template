// The notes behind /pwa-example, the dev-only worked example of an offline
// route and the outbox. Held in memory: the page exists under `nuxt dev` only,
// and a real app's writes go to its own tables.

export interface ExampleNote {
  id: string
  text: string
}

const notes = new Map<string, ExampleNote[]>()

/** 404 outside `nuxt dev`. `import.meta.dev` is a literal `false` in a build. */
export function requirePwaExample(): void {
  if (!import.meta.dev || process.env.NODE_ENV === 'production') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
}

export function listExampleNotes(userId: string): ExampleNote[] {
  return notes.get(userId) ?? []
}

export function addExampleNote(userId: string, text: string): ExampleNote {
  const note = { id: crypto.randomUUID(), text }
  notes.set(userId, [...listExampleNotes(userId), note])
  return note
}
