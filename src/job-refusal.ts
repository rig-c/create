import type { JobHostOptions } from '@rig-c/review/job-host';

export const reportOwnerSubmitRefusal: NonNullable<JobHostOptions['onRefusal']> = ({ code, route, bytes, limit }) => {
  const ceiling = limit === undefined ? '' : ` limit=${limit}`;
  process.stderr.write(`WARN JOB_OWNER_SUBMIT_REFUSED: ${code} ${route} bytes=${bytes}${ceiling}\n`);
};
