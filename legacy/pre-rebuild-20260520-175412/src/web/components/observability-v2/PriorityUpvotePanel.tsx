import React, { useEffect } from 'react';
import { usePriorityStore } from '../../stores/observabilityV2/usePriorityStore';

export const PriorityUpvotePanel: React.FC = () => {
  const { priorities, isLoading, error, fetchPriorities, upvote, downvote } = usePriorityStore();

  useEffect(() => {
    fetchPriorities();
  }, [fetchPriorities]);

  const handleUpvote = (initiativeId: string) => {
    // For MVP, hardcode user ID
    // TODO: Get from auth context in Phase 2
    upvote(initiativeId, 'user-grolf');
  };

  const handleDownvote = (initiativeId: string) => {
    downvote(initiativeId, 'user-grolf');
  };

  if (isLoading && priorities.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg bg-slate-900">
        <p className="text-slate-400">Loading priorities...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg bg-slate-900">
        <p className="text-red-400">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {priorities.map((priority, index) => (
        <div
          key={priority.initiativeId}
          className="rounded-lg border border-slate-700 bg-slate-900 p-3 hover:border-slate-600"
        >
          <div className="mb-2 flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-slate-400">#{index + 1}</span>
                <h4 className="text-sm font-semibold text-slate-100">{priority.initiativeName}</h4>
              </div>
              <p className="mt-1 text-xs text-slate-400">Score: {priority.priorityScore}</p>
            </div>

            <div className="flex flex-col items-end gap-1">
              <button
                type="button"
                onClick={() => handleUpvote(priority.initiativeId)}
                disabled={isLoading}
                className="flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                👍 {priority.upvotes}
              </button>
              <button
                type="button"
                onClick={() => handleDownvote(priority.initiativeId)}
                disabled={isLoading}
                className="flex items-center gap-1 rounded bg-slate-700 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-600 disabled:opacity-50"
              >
                👎 {priority.downvotes}
              </button>
            </div>
          </div>

          {priority.lastUpvotedAt && (
            <div className="mt-2 flex items-center gap-2 border-t border-slate-700 pt-2 text-xs text-slate-500">
              <span>Last upvoted by {priority.lastUpvotedBy || 'unknown'}</span>
              <span>•</span>
              <span>{new Date(priority.lastUpvotedAt).toLocaleString()}</span>
            </div>
          )}
        </div>
      ))}

      <div className="mt-4 rounded border border-slate-700 bg-slate-800 p-3 text-xs text-slate-400">
        <p className="font-semibold">⚠️ Phase 2: Tradeoff warnings</p>
        <p className="mt-1">
          Upvoting will trigger adversarial mode with impact analysis and tradeoff confirmation modal.
        </p>
      </div>
    </div>
  );
};
