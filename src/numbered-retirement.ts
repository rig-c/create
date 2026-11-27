import { refuse, USAGE_EXIT } from './refusal.ts';

/** Last Create release that can finish a numbered project with its original writers. */
export const LAST_NUMBERED_CREATE_RELEASE = '1.27.0';

export const NUMBERED_WRITER_REMOVED = 'NUMBERED_WRITER_REMOVED';

export interface NumberedWriterRetirement {
  readonly replacement: string;
  readonly path?: string;
}

/**
 * Refuse a removed numbered command or flag before any read or write, naming
 * the removed route, what to use on the current path, and the 1.x / adopt routes.
 */
export function refuseNumberedWriter(
  removed: string,
  instead?: string | NumberedWriterRetirement,
): never {
  const spec = typeof instead === 'string' ? { replacement: instead } : instead;
  const path = spec?.path ?? 'project.json';
  const replacementClause = spec?.replacement ? `${spec.replacement}; ` : '';
  refuse(
    NUMBERED_WRITER_REMOVED,
    `${path}: ${removed} was removed; ${replacementClause}stay on Create ${LAST_NUMBERED_CREATE_RELEASE} to finish the numbered project, or adopt onto the current path (docs/PROJECT.md#adopting-existing-numbered-outputs)`,
    USAGE_EXIT,
  );
}
