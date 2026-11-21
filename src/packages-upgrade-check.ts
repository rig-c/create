/** A fresh process avoids parts module-cache reuse across an install swap. */
import { checkProject, deriveProjectWaypoints } from './check.ts';
import { readPartsSections } from './parts-sections.ts';
if (import.meta.main) {
  const input = await Bun.stdin.json();
  const report = checkProject(input.dir, input.project, { now: input.now, readOnly: true });
  // The installed parts' placement, for the writer's config[] regeneration; null when the check could not read parts.
  const waypointConfigs = report.parts === null ? null
    : Object.fromEntries(deriveProjectWaypoints(input.project, readPartsSections(input.dir)).waypoints.map(w => [w.id, w.config]));
  process.stdout.write(JSON.stringify({ ...report, waypoint_configs: waypointConfigs }));
}
