/*
 * The agent-visualizer skill, bundled into the CLI from skills/agent-visualizer/SKILL.md
 * so `npx github:pvgomes/agent-visualizer install` can write it without shipping the skills folder.
 * Every agent we support reads the same SKILL.md format (YAML frontmatter with
 * name + description, markdown body), so one file serves all of them.
 */
import SKILL_MD from "../../skills/agent-visualizer/SKILL.md" with { type: "text" };

export const SKILL_NAME = "agent-visualizer";
export const SKILL_TEXT: string = SKILL_MD;
/** The line that marks a SKILL.md as ours, so uninstall never deletes a user's own skill. */
export const SKILL_MARKER = "Installed by agent-visualizer";

export function isOurSkill(text: string | null): boolean {
  return !!text && text.includes(SKILL_MARKER) && /^---\s*\nname:\s*agent-visualizer\s*$/m.test(text);
}
