import { skillText, skillDocument } from './documents';
import type { EditorSkill, EditorSkillPage } from './types';

const relight: EditorSkillPage = {
  name: skillDocument("genesis/references/relight.md").name,
  description: skillDocument("genesis/references/relight.md").description,
  body: skillText("genesis/references/relight.md"),
};

const depth: EditorSkillPage = {
  name: skillDocument("genesis/references/depth.md").name,
  description: skillDocument("genesis/references/depth.md").description,
  body: skillText("genesis/references/depth.md"),
};

export const genesis: EditorSkill = {
  name: skillDocument("genesis/SKILL.md").name,
  description: skillDocument("genesis/SKILL.md").description,
  body: skillText("genesis/SKILL.md"),
  pages: [relight, depth],
};
