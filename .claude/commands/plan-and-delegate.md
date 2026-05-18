# Plan-and-delegate

Bootstrap a kanban planning card (Opus) that will delegate execution to openclaude (qwen).

## What this does

Creates a new kanban card with `agentId="claude"` and `startInPlanMode=true`,
seeded with a prompt that reminds Opus to plan-only and to spawn `agentId="openclaude"`
execution cards per AGENTS.md → "Two-phase delegation".

## Steps

1. Take the goal from `$ARGUMENTS` (the rest of the user's message).
2. Summarize it into a short title (~5–8 words) for the card.
3. Run:

   ```sh
   kanban task create \
     --agent-id claude \
     --start-in-plan-mode \
     --title "<title>" \
     --prompt "GOAL: $ARGUMENTS

Follow AGENTS.md → 'Two-phase delegation'. Plan thoroughly, then delegate each mechanical sub-task by:

  kanban task create --agent-id openclaude --prompt '<detailed plan>'
  kanban task link --task-id \"\$KANBAN_TASK_ID\" --linked-task-id '<child-id>'

End your message with a short index of child card ids and titles."
   ```

4. Print the returned card id and remind the user to open `kanban` (the UI) and click Start on the card.

## Notes

- `KANBAN_TASK_ID` is injected into the spawned agent's env (see `src/terminal/session-manager.ts`), so the planning Opus can resolve its own id inside the card.
- Do **not** delegate inside this slash-command itself — this just creates the planning card; the actual Opus run happens when the user starts the card from the UI.
