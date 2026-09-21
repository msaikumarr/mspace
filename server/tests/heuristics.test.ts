import { describe, it, expect } from 'vitest';
import { parseDeadline, extractTasks, analyzeMeeting, summarizeText, guessPriority } from '../src/services/ai/heuristics';

const now = new Date('2030-01-09T10:00:00Z'); // a Wednesday

describe('deadline parsing', () => {
  it('handles ISO dates, weekdays, month names, relative phrases', () => {
    expect(parseDeadline('ship by 2030-02-01', now)).toContain('2030-02-01');
    expect(parseDeadline('due by Friday', now)).toContain('2030-01-11');
    expect(parseDeadline('finish by Oct 5', now)).toContain('2030-10-05');
    expect(parseDeadline('call them tomorrow', now)).toContain('2030-01-10');
    expect(parseDeadline('in 2 weeks we launch', now)).toContain('2030-01-23');
    expect(parseDeadline('no date here', now)).toBeUndefined();
  });
  it('rolls month/day dates that already passed into next year', () => {
    expect(parseDeadline('by Jan 2', now)).toContain('2031-01-02');
  });
});

describe('task extraction', () => {
  const text = `Project kickoff notes.
- Implement OAuth login with Google. This is required.
- Design the onboarding flow by 2030-02-15
* Alice will prepare the pricing table ASAP
The team should add pagination to the audit log.
It would be nice to have dark mode.
What about mobile support?
Random observation about the weather.`;
  it('extracts actionable lines with priority, owner and due date, skipping noise and questions', () => {
    const tasks = extractTasks(text, now);
    const titles = tasks.map((t) => t.title);
    expect(titles).toContain('Implement OAuth login with Google');
    expect(titles.join('|')).not.toMatch(/weather|mobile support/);
    expect(tasks.find((t) => /OAuth/.test(t.title))!.priority).toBe('HIGH');
    expect(tasks.find((t) => /onboarding/.test(t.title))!.dueDate).toContain('2030-02-15');
    const alice = tasks.find((t) => /pricing/.test(t.title))!;
    expect(alice.assigneeName).toBe('Alice');
    expect(alice.priority).toBe('URGENT');
    expect(tasks.find((t) => /dark mode/.test(t.description))?.priority ?? 'LOW').toBe('LOW');
    expect(new Set(titles).size).toBe(titles.length); // de-duplicated
  });
  it('classifies priority keywords', () => {
    expect(guessPriority('this is a critical blocker')).toBe('URGENT');
    expect(guessPriority('must support SSO')).toBe('HIGH');
    expect(guessPriority('maybe later')).toBe('LOW');
    expect(guessPriority('write docs')).toBe('MEDIUM');
  });
});

describe('meeting analysis & summarisation', () => {
  it('finds decisions, deadlines and owner-attributed action items', () => {
    const r = analyzeMeeting(`Sam: We decided to postpone the redesign until Q3.
Kim: I'll send the budget update by 2030-01-20.
Sam: The launch deadline is 2030-03-01.`, now);
    expect(r.decisions[0]).toMatch(/postpone the redesign/);
    expect(r.deadlines.join(' ')).toMatch(/2030-03-01/);
    const budget = r.actionItems.find((a) => /budget/i.test(a.title))!;
    expect(budget.assigneeName).toBe('Kim');
    expect(budget.dueDate).toContain('2030-01-20');
    expect(r.summary.length).toBeGreaterThan(0);
  });
  it('produces an extractive summary no longer than requested', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Fact number ${i} about the roadmap and billing system.`).join(' ');
    expect(summarizeText(long, 3).split(/(?<=\.)\s/).length).toBe(3);
    expect(summarizeText('Short text.', 3)).toBe('Short text.');
  });

  describe('meetings transcribed from speech (no speaker labels)', () => {
    it('turns first-person commitments and "let\'s" into unassigned action items', () => {
      const speech = "Thanks for joining. I will write the release notes by Friday. I'll fix the login bug. Let's schedule a follow-up next week.";
      const items = analyzeMeeting(speech).actionItems;
      expect(items.map((i) => i.title)).toEqual(['Write the release notes by Friday', 'Fix the login bug', 'Schedule a follow-up next week']);
      expect(items.every((i) => !i.assigneeName)).toBe(true);
      expect(items[0].dueDate).toBeTruthy(); // "by Friday" is still understood
    });

    it("does not treat \"Someone\" or \"Everybody\" as a person's name", () => {
      const items = analyzeMeeting('Someone should send the invoice to finance. Everybody should review the draft.').actionItems;
      expect(items).toHaveLength(2);
      expect(items.every((i) => !i.assigneeName)).toBe(true);
    });

    it('ignores first-person statements that are not commitments to do work', () => {
      expect(extractTasks("I will be out on Friday. I can hear you now. Let's not worry about it. I'll see you all soon.")).toEqual([]);
    });

    it('still attributes work to the named speaker when the transcript is labelled', () => {
      const items = analyzeMeeting("Sam: We decided to ship.\nKim: I'll write the release notes by Friday.").actionItems;
      expect(items).toMatchObject([{ title: 'Write the release notes by Friday', assigneeName: 'Kim' }]);
    });
  });
});
