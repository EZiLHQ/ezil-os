import { z } from 'zod';

const version = z.string().regex(/^arn:aws:states:us-east-1:[0-9]{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$/);
/** Operator mappings only; numeric versions, same account, separate machines. */
export const CancellationWorkflowMapSchema = z.record(version, version).refine(map => Object.entries(map).length <= 16
    && Object.entries(map).every(([source, target]) => source.split(':')[4] === target.split(':')[4]
        && source.slice(0, source.lastIndexOf(':')) !== target.slice(0, target.lastIndexOf(':'))));
