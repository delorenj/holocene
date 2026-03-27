import * as React from 'react';
import { clsx } from 'clsx';

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

const variantStyles: Record<BadgeVariant, string> = {
  default:
    'border-transparent bg-slate-700 text-slate-100 hover:bg-slate-700/80',
  secondary:
    'border-transparent bg-slate-600 text-slate-200 hover:bg-slate-600/80',
  destructive:
    'border-transparent bg-red-500/20 text-red-400 hover:bg-red-500/30',
  outline: 'text-slate-300 border border-slate-600',
};

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <div
      className={clsx(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2',
        variantStyles[variant],
        className
      )}
      {...props}
    />
  );
}
