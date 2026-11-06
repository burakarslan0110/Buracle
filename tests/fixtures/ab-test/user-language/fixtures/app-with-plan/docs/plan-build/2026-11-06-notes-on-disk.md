---
created: 2026-11-06
status: APPROVED
approved: true
worktree: false
type: Feature
iterations: 0
---
# Notizen auf der Festplatte speichern

## Goal
Die Notizen bleiben nach einem Neustart erhalten.
Done when:
- `addNote` schreibt jede Notiz in die Datei notes.json.

## Kontext
- Die Notizen liegen heute nur im Speicher (`src/notes.ts:5`).
- Befehle: Tests `bun test`.

## Umfang
- Drin: eine JSON-Datei im Arbeitsordner.
- Draußen: eine Datenbank.

## Ansatz
`addNote` schreibt die ganze Liste nach jeder Änderung in eine Datei.

## Tasks

### Task 1: Notizen in eine Datei schreiben

**Objective:** `addNote` schreibt alle Notizen in die Datei notes.json.

**Files:**
- Modify: `src/notes.ts`
- Create: `src/notes.test.ts`

**Definition of Done:**
- Nach `addNote` enthält die Datei notes.json die neue Notiz.
- Verify: `bun test src/notes.test.ts`

- [ ] Task 1 done

## E2E Scenarios
Keine: die Änderung hat keine Oberfläche.

## Risiken
Keine.

## Annahmen
Keine.
