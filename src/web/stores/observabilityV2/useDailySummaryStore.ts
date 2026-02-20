import { create } from 'zustand';
import type { DailySummary } from '../../types/observabilityV2';
import { mockDailySummary } from '../../fixtures/observabilityV2MockData';

interface DailySummaryStore {
  // State
  summary: DailySummary | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchDailySummary: () => Promise<void>;
  syncPlannedFromActuals: () => Promise<void>;
}

export const useDailySummaryStore = create<DailySummaryStore>((set, get) => ({
  // Initial state
  summary: null,
  isLoading: false,
  error: null,

  // Actions
  fetchDailySummary: async () => {
    set({ isLoading: true, error: null });
    try {
      // TODO: Replace with real API call
      await new Promise((resolve) => setTimeout(resolve, 300));
      set({ summary: mockDailySummary, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        isLoading: false,
      });
    }
  },

  syncPlannedFromActuals: async () => {
    set({ isLoading: true, error: null });
    try {
      // TODO: Replace with real API call
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      const { summary } = get();
      if (!summary) {
        throw new Error('No summary loaded');
      }

      // Copy actuals to planned
      const newSummary: DailySummary = {
        ...summary,
        planned: [...summary.actuals],
        deltas: summary.actuals.map((actual) => ({
          projectId: actual.projectId,
          delta: 0,
          severity: 'ok' as const,
        })),
      };

      set({ summary: newSummary, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        isLoading: false,
      });
    }
  },
}));
