import { scoreFromComponents } from "./scoring";
import type { TokenScorePoint } from "./types";
export type ScoreTrajectory = {
  direction: "rising" | "falling" | "flat" | "insufficient";
  phase: string;
  ratePointsPerDay: number | null;
  accelerationPointsPerDay2: number | null;
  drivers: Array<{ label: string; points: number }>;
  dataChanged: boolean;
};
const GROUPS: Array<[string, string[]]> = [
  ["Holding size", ["capital", "attentionFloor"]],
  ["Entity convergence", ["breadth", "evidenceCap"]],
  ["Favorite convergence", ["favorites"]],
  ["Relative conviction", ["conviction"]],
  ["Market cap / source confidence", ["marketCap"]],
  ["Holdings / market-cap footprint", ["footprint"]],
  ["Pool age", ["age"]],
  ["Liquidity", ["liquidity"]],
  ["Volume", ["volume"]],
  ["Observed holder momentum", ["momentumMultiplier"]],
];
function time(p: TokenScorePoint): number {
  return Date.parse(p.snapshotFinishedAt || p.snapshotCreatedAt);
}
export function withScoreTrajectories<T extends TokenScorePoint>(
  points: T[],
): T[] {
  return points.map((p, i) => {
    const trajectory: ScoreTrajectory = {
      direction: "insufficient",
      phase: "More completed observations needed",
      ratePointsPerDay: null,
      accelerationPointsPerDay2: null,
      drivers: [],
      dataChanged: false,
    };
    const a = points[i - 1],
      b = points[i - 2];
    const days = a ? (time(p) - time(a)) / 86400000 : NaN;
    if (
      a &&
      a.snapshotStatus === "success" &&
      p.snapshotStatus === "success" &&
      days > 0 &&
      a.scoreVersion === p.scoreVersion
    ) {
      const rate = (p.score - a.score) / days;
      trajectory.ratePointsPerDay = rate;
      trajectory.direction =
        p.score === a.score ? "flat" : rate > 0 ? "rising" : "falling";
      const beforeDays = b ? (time(a) - time(b)) / 86400000 : NaN;
      if (
        b?.snapshotStatus === "success" &&
        beforeDays > 0 &&
        b.scoreVersion === p.scoreVersion
      )
        trajectory.accelerationPointsPerDay2 =
          (rate - (a.score - b.score) / beforeDays) / ((days + beforeDays) / 2);
      const accel = trajectory.accelerationPointsPerDay2;
      trajectory.phase =
        trajectory.direction === "flat"
          ? "Flat"
          : accel == null
            ? rate > 0
              ? "Rising"
              : "Falling"
            : rate > 0
              ? accel > 0
                ? "Rising faster"
                : accel < 0
                  ? "Rising, losing pace"
                  : "Rising steadily"
              : accel < 0
                ? "Falling faster"
                : accel > 0
                  ? "Decline easing"
                  : "Falling steadily";
      trajectory.dataChanged =
        Boolean(p.holdingDynamics?.coverageChanged) ||
        a.marketCapEvidence?.status !== p.marketCapEvidence?.status ||
        a.marketCapEvidence?.source !== p.marketCapEvidence?.source;
      if (a.scoreComponents && p.scoreComponents) {
        const current = { ...a.scoreComponents };
        let last = scoreFromComponents(current);
        for (const [label, keys] of GROUPS) {
          for (const key of keys) current[key] = p.scoreComponents[key];
          const next = scoreFromComponents(current);
          if (next !== last)
            trajectory.drivers.push({ label, points: next - last });
          last = next;
        }
        trajectory.drivers.sort(
          (x, y) => Math.abs(y.points) - Math.abs(x.points),
        );
      }
    }
    return { ...p, trajectory };
  });
}
