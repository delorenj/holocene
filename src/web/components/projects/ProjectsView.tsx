import React, { useMemo, useState } from "react";
import {
  usePlaneWorkstreams,
  type Workstream,
} from "../../hooks/usePlaneWorkstreams";

// ---------------------------------------------------------------------------
// Quadrant definitions
// ---------------------------------------------------------------------------
type QuadrantId = "lasertoast" | "internal" | "digipop" | "jacksnaps";

type Quadrant = {
  id: QuadrantId;
  label: string;
  subtitle: string;
  position: "top-right" | "bottom-left" | "top-left" | "bottom-right";
  color: string; // border/accent
  bgColor: string; // background tint
  textColor: string;
};

const QUADRANTS: Quadrant[] = [
  {
    id: "lasertoast",
    label: "lasertoast",
    subtitle: "33GOD-powered products",
    position: "top-right",
    color: "#22c55e",
    bgColor: "bg-emerald-950/30",
    textColor: "text-emerald-400",
  },
  {
    id: "internal",
    label: "33GOD Internal",
    subtitle: "Infrastructure & platform",
    position: "bottom-left",
    color: "#3b82f6",
    bgColor: "bg-blue-950/30",
    textColor: "text-blue-400",
  },
  {
    id: "digipop",
    label: "DigiPop Studios",
    subtitle: "Vectors, fonts, coloring books",
    position: "top-left",
    color: "#f59e0b",
    bgColor: "bg-amber-950/30",
    textColor: "text-amber-400",
  },
  {
    id: "jacksnaps",
    label: "Jacksnaps",
    subtitle: "T-shirts, stickers, merch",
    position: "bottom-right",
    color: "#ef4444",
    bgColor: "bg-rose-950/30",
    textColor: "text-rose-400",
  },
];

// ---------------------------------------------------------------------------
// Project type
// ---------------------------------------------------------------------------
type Project = {
  id: string;
  name: string;
  quadrant: QuadrantId;
  color: string;
  issueCount: number;
  activeCount: number;
  source: "plane" | "static";
  planeProjectId?: string;
};

// ---------------------------------------------------------------------------
// Map Plane project IDs → quadrants
// ---------------------------------------------------------------------------
const PLANE_PROJECT_MAP: Record<
  string,
  { quadrant: QuadrantId; color: string }
> = {
  "cbfbb641-33e2-43c6-a7d1-ce63136ab689": {
    quadrant: "internal",
    color: "#8b5cf6",
  }, // perth (main board)
  "10d06f8d-c110-4ce5-beaa-0914534b090a": {
    quadrant: "internal",
    color: "#ef4444",
  }, // bloodbank
  "c5d51c41-eaf0-44ae-93ab-0a74712c3b86": {
    quadrant: "internal",
    color: "#06b6d4",
  }, // holocene
  "495de1b1-a4a2-4456-a185-351885858b1e": {
    quadrant: "internal",
    color: "#f97316",
  }, // imi
};

// Project display names (better than raw Plane names)
const PLANE_PROJECT_NAMES: Record<string, string> = {
  "cbfbb641-33e2-43c6-a7d1-ce63136ab689": "Perth Board",
  "10d06f8d-c110-4ce5-beaa-0914534b090a": "Bloodbank",
  "c5d51c41-eaf0-44ae-93ab-0a74712c3b86": "Holocene",
  "495de1b1-a4a2-4456-a185-351885858b1e": "iMi",
};

// Static projects not yet in Plane
const STATIC_PROJECTS: Project[] = [
  {
    id: "holyfields",
    name: "Holyfields",
    quadrant: "internal",
    color: "#a855f7",
    issueCount: 0,
    activeCount: 0,
    source: "static",
  },
  {
    id: "candystore",
    name: "Candystore",
    quadrant: "internal",
    color: "#ec4899",
    issueCount: 0,
    activeCount: 0,
    source: "static",
  },
  {
    id: "theboard",
    name: "TheBoard",
    quadrant: "internal",
    color: "#14b8a6",
    issueCount: 0,
    activeCount: 0,
    source: "static",
  },
  {
    id: "dp-vectors",
    name: "Vector Packs",
    quadrant: "digipop",
    color: "#f59e0b",
    issueCount: 0,
    activeCount: 0,
    source: "static",
  },
  {
    id: "dp-fonts",
    name: "Fonts",
    quadrant: "digipop",
    color: "#fbbf24",
    issueCount: 0,
    activeCount: 0,
    source: "static",
  },
  {
    id: "dp-coloring",
    name: "Coloring Books",
    quadrant: "digipop",
    color: "#d97706",
    issueCount: 0,
    activeCount: 0,
    source: "static",
  },
  {
    id: "dp-invites",
    name: "Invitations",
    quadrant: "digipop",
    color: "#f97316",
    issueCount: 0,
    activeCount: 0,
    source: "static",
  },
  {
    id: "js-tees",
    name: "T-Shirts",
    quadrant: "jacksnaps",
    color: "#ef4444",
    issueCount: 0,
    activeCount: 0,
    source: "static",
  },
  {
    id: "js-stickers",
    name: "Bumper Stickers",
    quadrant: "jacksnaps",
    color: "#f87171",
    issueCount: 0,
    activeCount: 0,
    source: "static",
  },
];

// ---------------------------------------------------------------------------
// Derive projects from Plane workstreams
// ---------------------------------------------------------------------------
function deriveProjects(workstreams: Workstream[] | undefined): Project[] {
  const planeProjects = new Map<string, Project>();

  if (workstreams) {
    for (const ws of workstreams) {
      const projectId = ws.planeLinks[0]?.project ?? "";
      const mapping = PLANE_PROJECT_MAP[projectId];
      if (!mapping) continue;

      const existing = planeProjects.get(projectId);
      if (existing) {
        existing.issueCount++;
        if (ws.status === "active") existing.activeCount++;
      } else {
        planeProjects.set(projectId, {
          id: projectId,
          name: PLANE_PROJECT_NAMES[projectId] ?? projectId,
          quadrant: mapping.quadrant,
          color: mapping.color,
          issueCount: 1,
          activeCount: ws.status === "active" ? 1 : 0,
          source: "plane",
          planeProjectId: projectId,
        });
      }
    }
  }

  return [...planeProjects.values(), ...STATIC_PROJECTS];
}

// ---------------------------------------------------------------------------
// Project circle component
// ---------------------------------------------------------------------------
const ProjectCircle: React.FC<{
  project: Project;
  onClick: (p: Project) => void;
}> = ({ project, onClick }) => {
  const baseSize = 80;
  // Scale slightly with issue count (min 80, max 140)
  const size = Math.min(140, baseSize + project.issueCount * 4);

  return (
    <button
      type="button"
      onClick={() => onClick(project)}
      className="group relative flex items-center justify-center rounded-full border-2 transition-all duration-300 hover:scale-110 hover:shadow-lg"
      style={{
        width: size,
        height: size,
        borderColor: project.color,
        backgroundColor: `${project.color}15`,
        boxShadow:
          project.activeCount > 0 ? `0 0 20px ${project.color}30` : undefined,
      }}
      title={`${project.name} — ${project.issueCount} tickets, ${project.activeCount} active`}
    >
      {/* Pulse ring for active projects */}
      {project.activeCount > 0 && (
        <span
          className="absolute inset-0 animate-ping rounded-full opacity-20"
          style={{ borderColor: project.color, border: "2px solid" }}
        />
      )}

      <span
        className="text-center text-[11px] font-bold leading-tight px-2"
        style={{ color: project.color }}
      >
        {project.name}
      </span>

      {/* Badge with count */}
      {project.issueCount > 0 && (
        <span
          className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
          style={{ backgroundColor: project.color }}
        >
          {project.issueCount}
        </span>
      )}
    </button>
  );
};

// ---------------------------------------------------------------------------
// Quadrant component
// ---------------------------------------------------------------------------
const QuadrantPane: React.FC<{
  quadrant: Quadrant;
  projects: Project[];
  onProjectClick: (p: Project) => void;
}> = ({ quadrant, projects, onProjectClick }) => {
  return (
    <div
      className={`flex flex-col rounded-2xl border border-slate-800/60 p-4 ${quadrant.bgColor}`}
    >
      {/* Quadrant header */}
      <div className="mb-4">
        <h3 className={`text-sm font-bold ${quadrant.textColor}`}>
          {quadrant.label}
        </h3>
        <p className="text-[10px] text-slate-500">{quadrant.subtitle}</p>
      </div>

      {/* Project circles */}
      <div className="flex flex-1 flex-wrap items-center justify-center gap-4 py-2">
        {projects.length === 0 ? (
          <span className="text-xs text-slate-600 italic">No projects yet</span>
        ) : (
          projects.map((p) => (
            <ProjectCircle key={p.id} project={p} onClick={onProjectClick} />
          ))
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export const ProjectsView: React.FC = () => {
  const { data: workstreams, isLoading, error } = usePlaneWorkstreams();
  const [selected, setSelected] = useState<Project | null>(null);

  const projects = useMemo(() => deriveProjects(workstreams), [workstreams]);

  const projectsByQuadrant = useMemo(() => {
    const map: Record<QuadrantId, Project[]> = {
      lasertoast: [],
      internal: [],
      digipop: [],
      jacksnaps: [],
    };
    for (const p of projects) {
      map[p.quadrant].push(p);
    }
    return map;
  }, [projects]);

  const totalActive = useMemo(
    () => projects.reduce((sum, p) => sum + p.activeCount, 0),
    [projects],
  );
  const totalIssues = useMemo(
    () => projects.reduce((sum, p) => sum + p.issueCount, 0),
    [projects],
  );

  // Quadrant ordering: top-left, top-right, bottom-left, bottom-right
  const topLeft = QUADRANTS.find((q) => q.position === "top-left")!;
  const topRight = QUADRANTS.find((q) => q.position === "top-right")!;
  const bottomLeft = QUADRANTS.find((q) => q.position === "bottom-left")!;
  const bottomRight = QUADRANTS.find((q) => q.position === "bottom-right")!;

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400">
            {isLoading
              ? "Loading projects…"
              : error
                ? "Failed to load Plane data"
                : `${projects.length} projects · ${totalIssues} tickets · ${totalActive} active`}
          </span>
        </div>
      </div>

      {/* Quadrant grid — 2×2 */}
      <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-2 p-3 overflow-hidden">
        <QuadrantPane
          quadrant={topLeft}
          projects={projectsByQuadrant[topLeft.id]}
          onProjectClick={setSelected}
        />
        <QuadrantPane
          quadrant={topRight}
          projects={projectsByQuadrant[topRight.id]}
          onProjectClick={setSelected}
        />
        <QuadrantPane
          quadrant={bottomLeft}
          projects={projectsByQuadrant[bottomLeft.id]}
          onProjectClick={setSelected}
        />
        <QuadrantPane
          quadrant={bottomRight}
          projects={projectsByQuadrant[bottomRight.id]}
          onProjectClick={setSelected}
        />
      </div>

      {/* Detail drawer */}
      {selected && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setSelected(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="h-10 w-10 rounded-full border-2 flex items-center justify-center"
                  style={{
                    borderColor: selected.color,
                    backgroundColor: `${selected.color}20`,
                  }}
                >
                  <span className="text-lg" style={{ color: selected.color }}>
                    ●
                  </span>
                </div>
                <div>
                  <h3 className="font-bold text-slate-100">{selected.name}</h3>
                  <p className="text-xs text-slate-500">
                    {QUADRANTS.find((q) => q.id === selected.quadrant)?.label} ·{" "}
                    {selected.source === "plane" ? "Plane" : "Static"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg border border-slate-700 px-2 py-1 text-sm text-slate-400 hover:bg-slate-800"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">
                  Total Tickets
                </p>
                <p className="mt-1 text-xl font-bold text-slate-100">
                  {selected.issueCount}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">
                  Active
                </p>
                <p
                  className="mt-1 text-xl font-bold"
                  style={{ color: selected.color }}
                >
                  {selected.activeCount}
                </p>
              </div>
            </div>

            {selected.planeProjectId && (
              <a
                href={`https://plane.delo.sh/33god/projects/${selected.planeProjectId}/issues/`}
                target="_blank"
                rel="noreferrer"
                className="mt-4 block rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-center text-sm text-slate-300 hover:bg-slate-700"
              >
                Open in Plane →
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
