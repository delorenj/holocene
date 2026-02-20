import { create } from 'zustand';
import type { Initiative } from '../../types/observabilityV2';
import { mockInitiatives } from '../../fixtures/observabilityV2MockData';

type TimeRange = '7d' | '30d' | 'all';

interface ObservabilityStore {
  // State
  initiatives: Initiative[];
  timeRange: TimeRange;
  anomalyThreshold: number;
  showCompleted: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchInitiatives: () => Promise<void>;
  setTimeRange: (range: TimeRange) => void;
  setAnomalyThreshold: (threshold: number) => void;
  toggleShowCompleted: () => void;
}

export const useObservabilityStore = create<ObservabilityStore>((set, get) => ({
  // Initial state
  initiatives: [],
  timeRange: '7d',
  anomalyThreshold: 1000,
  showCompleted: false,
  isLoading: false,
  error: null,

  // Actions
  fetchInitiatives: async () => {
    set({ isLoading: true, error: null });
    try {
      // TODO: Replace with real API call
      // For now, simulate network delay with mock data
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      const { anomalyThreshold } = get();
      
      // Filter and recompute anomalies based on current threshold
      const initiatives = mockInitiatives.map((init) => ({
        ...init,
        isAnomaly: init.tokenSpend7d > anomalyThreshold && init.progressPercent < 20,
        anomalyReason:
          init.tokenSpend7d > anomalyThreshold && init.progressPercent < 20
            ? `High token spend (${(init.tokenSpend7d / 1000).toFixed(0)}k) with <20% progress`
            : undefined,
      }));

      set({ initiatives, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        isLoading: false,
      });
    }
  },

  setTimeRange: (range: TimeRange) => {
    set({ timeRange: range });
    // Re-fetch with new time range
    get().fetchInitiatives();
  },

  setAnomalyThreshold: (threshold: number) => {
    set({ anomalyThreshold: threshold });
    // Recompute anomalies
    const { initiatives } = get();
    const updated = initiatives.map((init) => ({
      ...init,
      isAnomaly: init.tokenSpend7d > threshold && init.progressPercent < 20,
      anomalyReason:
        init.tokenSpend7d > threshold && init.progressPercent < 20
          ? `High token spend (${(init.tokenSpend7d / 1000).toFixed(0)}k) with <20% progress`
          : undefined,
    }));
    set({ initiatives: updated });
  },

  toggleShowCompleted: () => {
    set((state) => ({ showCompleted: !state.showCompleted }));
  },
}));
