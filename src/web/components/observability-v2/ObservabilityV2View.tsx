import React, { useEffect } from 'react';
import { InitiativeBubbleMap } from './InitiativeBubbleMap';
import { DailySummaryPies } from './DailySummaryPies';
import { PriorityUpvotePanel } from './PriorityUpvotePanel';

export const ObservabilityV2View: React.FC = () => {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-950 text-slate-100">
      <div className="border-b border-slate-800 px-4 py-3">
        <h2 className="text-xl font-bold">Observability v2 🔬</h2>
        <p className="text-sm text-slate-400">
          Token spend vs progress • Daily accountability • Adversarial priority management
        </p>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Main content area - 2/3 width */}
        <div className="flex flex-1 flex-col overflow-y-auto p-4">
          {/* Bubble Map */}
          <section className="mb-6">
            <h3 className="mb-3 text-lg font-semibold">Initiative Bubble Map 🫧</h3>
            <InitiativeBubbleMap />
          </section>

          {/* Daily Summary Pies */}
          <section className="mb-6">
            <h3 className="mb-3 text-lg font-semibold">Daily Summary 🥧</h3>
            <DailySummaryPies />
          </section>
        </div>

        {/* Priority Panel - 1/3 width */}
        <aside className="w-96 overflow-y-auto border-l border-slate-800 p-4">
          <h3 className="mb-3 text-lg font-semibold">Priority Upvotes ⬆️</h3>
          <PriorityUpvotePanel />
        </aside>
      </div>
    </div>
  );
};
