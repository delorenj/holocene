/**
 * ProjectCard Molecule Component
 * Displays project summary information
 */

import { Card, CardHeader, CardTitle, CardContent } from '../atoms/Card';
import { ProjectStatus } from '@domain/models/Project';
import { clsx } from 'clsx';

export interface ProjectCardProps {
  projectName: string;
  status: ProjectStatus;
  repoCount: number;
  momentum: number;
  lastActivityAt: Date;
  onClick?: () => void;
}

const statusColors: Record<ProjectStatus, string> = {
  [ProjectStatus.PLANNING]: 'bg-yellow-100 text-yellow-800',
  [ProjectStatus.ACTIVE]: 'bg-green-100 text-green-800',
  [ProjectStatus.ON_HOLD]: 'bg-orange-100 text-orange-800',
  [ProjectStatus.COMPLETED]: 'bg-blue-100 text-blue-800',
  [ProjectStatus.ARCHIVED]: 'bg-gray-100 text-gray-800',
};

function formatMomentum(momentum: number): string {
  if (momentum >= 1000) {
    return `${(momentum / 1000).toFixed(1)}k`;
  }
  return momentum.toString();
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export function ProjectCard({
  projectName,
  status,
  repoCount,
  momentum,
  lastActivityAt,
  onClick,
}: ProjectCardProps) {
  return (
    <Card
      variant="elevated"
      className={clsx(
        'cursor-pointer transition-transform hover:scale-[1.02]',
        onClick && 'hover:shadow-lg'
      )}
      onClick={onClick}
    >
      <CardHeader>
        <div className="flex items-start justify-between">
          <CardTitle>{projectName}</CardTitle>
          <span
            className={clsx(
              'px-2 py-1 text-xs font-medium rounded-full',
              statusColors[status]
            )}
          >
            {status}
          </span>
        </div>
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs mb-1">Repos</p>
            <p className="font-semibold text-gray-900">{repoCount}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Momentum</p>
            <p className="font-semibold text-gray-900">{formatMomentum(momentum)}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">Last Activity</p>
            <p className="font-semibold text-gray-900">
              {formatRelativeTime(lastActivityAt)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
