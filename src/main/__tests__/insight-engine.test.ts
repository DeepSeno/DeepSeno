import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InsightEngine } from '../agent/insight-engine';
import type { Insight } from '../agent/insight-engine';

function makeDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

describe('InsightEngine', () => {
  let mockDb: any;
  let engine: InsightEngine;

  beforeEach(() => {
    mockDb = {
      getActiveExtractedItems: vi.fn().mockReturnValue([]),
      getAllSpeakers: vi.fn().mockReturnValue([]),
      getAllRecordings: vi.fn().mockReturnValue([]),
    };
    engine = new InsightEngine(mockDb);
  });

  // ─── scan() ─────────────────────────────────────────────────

  describe('scan()', () => {
    it('returns empty array when no data', async () => {
      const insights = await engine.scan();
      expect(insights).toEqual([]);
    });

    it('combines all insight types', async () => {
      const yesterday = makeDate(-1);
      const tomorrow = makeDate(1);

      mockDb.getActiveExtractedItems.mockReturnValue([
        // Should appear in checkPendingTodos (due tomorrow)
        { id: 1, type: 'todo', status: 'active', content: 'Review doc', due_date: tomorrow, segment_id: null, related_person: null, source: 'pipeline' },
        // Should appear in detectAnomalies (overdue)
        { id: 2, type: 'todo', status: 'active', content: 'Send report', due_date: yesterday, segment_id: null, related_person: null, source: 'pipeline' },
      ]);
      mockDb.getAllSpeakers.mockReturnValue([
        { id: 1, name: 'Alice', segment_count: 20, total_duration: 500, voice_signature: null, first_seen_at: null, notes: null },
      ]);

      const insights = await engine.scan();

      const types = insights.map((i) => i.type);
      // Should have todo_reminder (from yesterday item being both <=tomorrow and overdue, plus tomorrow item)
      expect(types).toContain('todo_reminder');
      expect(types).toContain('person_frequency');
      expect(types).toContain('anomaly');
      expect(insights.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── checkPendingTodos() ────────────────────────────────────

  describe('checkPendingTodos()', () => {
    it('finds todos due tomorrow', () => {
      const tomorrow = makeDate(1);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'todo', status: 'active', content: 'Finish report', due_date: tomorrow, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.checkPendingTodos();
      expect(insights).toHaveLength(1);
      expect(insights[0]).toEqual({
        type: 'todo_reminder',
        title: '待办即将到期',
        detail: `"Finish report" 截止日期: ${tomorrow}`,
        urgency: 'high',
      });
    });

    it('finds todos due today', () => {
      const today = makeDate(0);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'todo', status: 'active', content: 'Call client', due_date: today, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.checkPendingTodos();
      expect(insights).toHaveLength(1);
      expect(insights[0].detail).toContain('Call client');
    });

    it('finds overdue todos (due_date in the past)', () => {
      const pastDate = makeDate(-3);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'todo', status: 'active', content: 'Overdue task', due_date: pastDate, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.checkPendingTodos();
      // Past dates are also <= tomorrow, so they should appear
      expect(insights).toHaveLength(1);
      expect(insights[0].detail).toContain('Overdue task');
    });

    it('ignores completed todos', () => {
      const tomorrow = makeDate(1);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'todo', status: 'completed', content: 'Done task', due_date: tomorrow, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      // getActiveExtractedItems returns only active items, but the filter also checks status
      // Since the mock returns completed status, the filter should exclude it
      const insights = engine.checkPendingTodos();
      expect(insights).toHaveLength(0);
    });

    it('ignores todos without due date', () => {
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'todo', status: 'active', content: 'No deadline task', due_date: null, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.checkPendingTodos();
      expect(insights).toHaveLength(0);
    });

    it('ignores non-todo items', () => {
      const tomorrow = makeDate(1);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'meeting', status: 'active', content: 'Team sync', due_date: tomorrow, segment_id: null, related_person: null, source: 'pipeline' },
        { id: 2, type: 'decision', status: 'active', content: 'Use React', due_date: tomorrow, segment_id: null, related_person: null, source: 'pipeline' },
        { id: 3, type: 'contact', status: 'active', content: 'John', due_date: tomorrow, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.checkPendingTodos();
      expect(insights).toHaveLength(0);
    });

    it('ignores todos due far in the future', () => {
      const futureDate = makeDate(30);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'todo', status: 'active', content: 'Far future task', due_date: futureDate, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.checkPendingTodos();
      expect(insights).toHaveLength(0);
    });

    it('returns empty array when db method is missing', () => {
      const brokenDb = {} as any;
      const brokenEngine = new InsightEngine(brokenDb);
      const insights = brokenEngine.checkPendingTodos();
      expect(insights).toEqual([]);
    });
  });

  // ─── analyzePersonFrequency() ──────────────────────────────

  describe('analyzePersonFrequency()', () => {
    it('reports high-frequency speakers (segment_count > 10)', () => {
      mockDb.getAllSpeakers.mockReturnValue([
        { id: 1, name: 'Alice', segment_count: 25, total_duration: 600, voice_signature: null, first_seen_at: null, notes: null },
        { id: 2, name: 'Bob', segment_count: 15, total_duration: 400, voice_signature: null, first_seen_at: null, notes: null },
      ]);

      const insights = engine.analyzePersonFrequency();
      expect(insights).toHaveLength(1);
      expect(insights[0].type).toBe('person_frequency');
      expect(insights[0].title).toBe('高频联系人');
      expect(insights[0].detail).toContain('Alice: 25段对话');
      expect(insights[0].detail).toContain('Bob: 15段对话');
      expect(insights[0].urgency).toBe('low');
    });

    it('returns empty for low-frequency speakers (segment_count <= 10)', () => {
      mockDb.getAllSpeakers.mockReturnValue([
        { id: 1, name: 'Charlie', segment_count: 5, total_duration: 100, voice_signature: null, first_seen_at: null, notes: null },
        { id: 2, name: 'Dave', segment_count: 3, total_duration: 50, voice_signature: null, first_seen_at: null, notes: null },
      ]);

      const insights = engine.analyzePersonFrequency();
      expect(insights).toHaveLength(0);
    });

    it('uses "Unknown" for speakers without a name', () => {
      mockDb.getAllSpeakers.mockReturnValue([
        { id: 1, name: null, segment_count: 20, total_duration: 400, voice_signature: null, first_seen_at: null, notes: null },
      ]);

      const insights = engine.analyzePersonFrequency();
      expect(insights).toHaveLength(1);
      expect(insights[0].detail).toContain('Unknown: 20段对话');
    });

    it('returns empty when db method is missing', () => {
      const brokenDb = {} as any;
      const brokenEngine = new InsightEngine(brokenDb);
      const insights = brokenEngine.analyzePersonFrequency();
      expect(insights).toEqual([]);
    });

    it('handles db error gracefully', () => {
      mockDb.getAllSpeakers.mockImplementation(() => {
        throw new Error('DB error');
      });

      const insights = engine.analyzePersonFrequency();
      expect(insights).toEqual([]);
    });
  });

  // ─── detectAnomalies() ──────────────────────────────────────

  describe('detectAnomalies()', () => {
    it('finds overdue todos', () => {
      const yesterday = makeDate(-1);
      const twoDaysAgo = makeDate(-2);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'todo', status: 'active', content: 'Task A', due_date: yesterday, segment_id: null, related_person: null, source: 'pipeline' },
        { id: 2, type: 'todo', status: 'active', content: 'Task B', due_date: twoDaysAgo, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.detectAnomalies();
      expect(insights).toHaveLength(1);
      expect(insights[0]).toEqual({
        type: 'anomaly',
        title: '逾期待办',
        detail: '2个待办已过截止日期',
        urgency: 'high',
      });
    });

    it('returns empty when no overdue items', () => {
      const tomorrow = makeDate(1);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'todo', status: 'active', content: 'Future task', due_date: tomorrow, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.detectAnomalies();
      expect(insights).toHaveLength(0);
    });

    it('ignores todos due today (not yet overdue)', () => {
      const today = makeDate(0);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'todo', status: 'active', content: 'Due today', due_date: today, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.detectAnomalies();
      // due_date < todayStr is strict, so today's date is NOT overdue
      expect(insights).toHaveLength(0);
    });

    it('ignores non-todo items with past due dates', () => {
      const yesterday = makeDate(-1);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'meeting', status: 'active', content: 'Past meeting', due_date: yesterday, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.detectAnomalies();
      expect(insights).toHaveLength(0);
    });

    it('ignores completed overdue todos', () => {
      const yesterday = makeDate(-1);
      mockDb.getActiveExtractedItems.mockReturnValue([
        { id: 1, type: 'todo', status: 'completed', content: 'Done task', due_date: yesterday, segment_id: null, related_person: null, source: 'pipeline' },
      ]);

      const insights = engine.detectAnomalies();
      expect(insights).toHaveLength(0);
    });

    it('returns empty when db method is missing', () => {
      const brokenDb = {} as any;
      const brokenEngine = new InsightEngine(brokenDb);
      const insights = brokenEngine.detectAnomalies();
      expect(insights).toEqual([]);
    });

    it('handles db error gracefully', () => {
      mockDb.getActiveExtractedItems.mockImplementation(() => {
        throw new Error('DB error');
      });

      const insights = engine.detectAnomalies();
      expect(insights).toEqual([]);
    });
  });
});
