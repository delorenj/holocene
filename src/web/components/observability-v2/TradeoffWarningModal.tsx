import React from 'react';
import type { TradeoffWarning } from '../../types/observabilityV2';

interface TradeoffWarningModalProps {
  warning: TradeoffWarning;
  onConfirm: () => void;
  onCancel: () => void;
}

export const TradeoffWarningModal: React.FC<TradeoffWarningModalProps> = ({
  warning,
  onConfirm,
  onCancel,
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-slate-900 p-6 shadow-xl">
        <h3 className="mb-4 text-xl font-bold text-slate-100">⚠️ Tradeoff Warning</h3>

        <div className="mb-4 rounded border border-amber-700 bg-amber-900/20 p-3 text-sm text-amber-200">
          <p className="font-semibold">Upvoting "{warning.targetInitiativeName}" will impact:</p>
        </div>

        <div className="mb-6 space-y-3">
          {warning.impacts.map((impact) => (
            <div
              key={impact.initiativeId}
              className="rounded border border-slate-700 bg-slate-800 p-3"
            >
              <p className="font-semibold text-slate-100">{impact.initiativeName}</p>
              <ul className="mt-2 space-y-1 text-sm text-slate-300">
                <li>
                  Token reallocation: <span className="font-mono text-rose-400">{impact.tokenDelta}</span> tokens/day
                </li>
                <li>
                  Progress impact: <span className="font-mono text-rose-400">{impact.progressDelta}%</span>
                </li>
                <li>
                  Estimated delay: <span className="font-mono text-rose-400">{impact.delayDays} days</span>
                </li>
              </ul>
            </div>
          ))}
        </div>

        <div className="mb-6 rounded border border-slate-700 bg-slate-800 p-3 text-sm">
          <p className="font-semibold text-slate-100">Risk Level: {warning.riskLevel.toUpperCase()}</p>
          <p className="mt-1 text-slate-300">{warning.riskReason}</p>
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Yes, shift focus
          </button>
        </div>
      </div>
    </div>
  );
};
