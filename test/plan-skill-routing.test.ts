import { describe, expect, it } from 'vitest';
import { SkillCatalogService } from '../src/core/skills/SkillCatalogService';
import {
  loadPlanningSkillPlaybooks,
  resolvePlanningSkillNames,
} from '../src/core/plan/planSkillRouting';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('planSkillRouting', () => {
  it('resolves planning-and-task-breakdown for feature plans', () => {
    const names = resolvePlanningSkillNames('feature', {
      kind: 'implementation',
      complexity: 'high',
      summary: 'Build SDK',
      shouldPlan: true,
      shouldVerify: true,
      shouldUseSubagents: false,
    });
    expect(names).toContain('using-agent-skills');
    expect(names).toContain('planning-and-task-breakdown');
  });

  it('loads skill playbooks from workspace catalog', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'mitii-plan-skills-'));
    try {
      const skillDir = join(workspace, '.mitii', 'skills', 'planning-and-task-breakdown');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: planning-and-task-breakdown
description: Breaks work into ordered tasks.
---

# Planning and Task Breakdown
`,
        'utf8'
      );

      const catalog = new SkillCatalogService(workspace);
      catalog.refresh();
      const { context, loaded } = loadPlanningSkillPlaybooks(catalog, ['planning-and-task-breakdown']);
      expect(loaded).toContain('planning-and-task-breakdown');
      expect(context).toContain('Planning skill playbooks');
      expect(context).toContain('Planning and Task Breakdown');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
