// A small notes app used by the ab-test of PRD 2026-11-06.
// TODO: store notes on disk.
export interface Note { id: string, title: string, body: string }

const notes: Note[] = []

export function addNote(title: string, body: string): Note {
  const note = { id: String(notes.length + 1), title, body }
  notes.push(note)
  return note
}

export function listNotes(): readonly Note[] {
  return notes
}
