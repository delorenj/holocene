import { create } from 'zustand';
import type { InitiativePriority, TradeoffWarning } from '../../types/observabilityV2';
import { mockPriorities } from '../../fixtures/observabilityV2MockData';

interface PriorityStore {
  // State
  priorities: InitiativePriority[];
  upvotePending: string | null;
  tradeoffWarning: TradeoffWarning | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchPriorities: () => Promise<void>;
  upvote: (initiativeId: string, userId: string) => Promise<void>;
  confirmUpvote: (initiativeId: string, userId: string) => Promise<void>;
  cancelUpvote: () => void;
  downvote: (initiativeId: string, userId: string) => Promise<void>;
}

export const usePriorityStore = create<PriorityStore>((set, get) => ({
  // Initial state
  priorities: [],
  upvotePending: null,
  tradeoffWarning: null,
  isLoading: false,
  error: null,

  // Actions
  fetchPriorities: async () => {
    set({ isLoading: true, error: null });
    try {
      // TODO: Replace with real API call
      await new Promise((resolve) => setTimeout(resolve, 300));
      set({ priorities: [...mockPriorities].sort((a, b) => b.priorityScore - a.priorityScore), isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        isLoading: false,
      });
    }
  },

  upvote: async (initiativeId: string, userId: string) => {
    set({ isLoading: true, error: null, upvotePending: initiativeId });
    try {
      // TODO: Replace with real API call
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Mock tradeoff warning (for MVP, just log)
      console.log('[MOCK] Upvote initiated for', initiativeId, 'by', userId);
      
      // For now, just increment upvote count without tradeoff warning
      const { priorities } = get();
      const updated = priorities.map((p) => {
        if (p.initiativeId === initiativeId) {
          return {
            ...p,
            upvotes: p.upvotes + 1,
            priorityScore: Math.min(100, p.priorityScore + 5),
            lastUpvotedAt: new Date().toISOString(),
            lastUpvotedBy: userId,
          };
        }
        return p;
      });

      set({
        priorities: updated.sort((a, b) => b.priorityScore - a.priorityScore),
        upvotePending: null,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        upvotePending: null,
        isLoading: false,
      });
    }
  },

  confirmUpvote: async (initiativeId: string, userId: string) => {
    // TODO: Implement tradeoff confirmation in Phase 2
    console.log('[MOCK] Upvote confirmed for', initiativeId, 'by', userId);
    set({ upvotePending: null, tradeoffWarning: null });
  },

  cancelUpvote: () => {
    set({ upvotePending: null, tradeoffWarning: null });
  },

  downvote: async (initiativeId: string, userId: string) => {
    set({ isLoading: true, error: null });
    try {
      // TODO: Replace with real API call
      await new Promise((resolve) => setTimeout(resolve, 300));

      console.log('[MOCK] Downvote for', initiativeId, 'by', userId);

      const { priorities } = get();
      const updated = priorities.map((p) => {
        if (p.initiativeId === initiativeId) {
          return {
            ...p,
            downvotes: p.downvotes + 1,
            priorityScore: Math.max(0, p.priorityScore - 5),
          };
        }
        return p;
      });

      set({
        priorities: updated.sort((a, b) => b.priorityScore - a.priorityScore),
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        isLoading: false,
      });
    }
  },
}));
